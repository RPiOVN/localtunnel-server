import log from 'bookrc';
import express from 'express';
import tldjs from 'tldjs';
import on_finished from 'on-finished';
import Debug from 'debug';
import http_proxy from 'http-proxy';
import http from 'http';
import Promise from 'bluebird';

var useragent = require('express-useragent');

import Proxy from './proxy';
import rand_id from './lib/rand_id';
import BindingAgent from './lib/BindingAgent';

const debug = Debug('localtunnel:server');

const proxy = http_proxy.createProxyServer({
    target: 'http://localtunnel.github.io'
});

proxy.on('error', function(err) {
    log.error(err);
});

proxy.on('proxyReq', function(proxyReq, req, res, options) {
    // rewrite the request so it hits the correct url on github
    // also make sure host header is what we expect
    proxyReq.path = '/www' + proxyReq.path;
    proxyReq.setHeader('host', 'localtunnel.github.io');
});

const PRODUCTION = process.env.NODE_ENV === 'production';

// id -> client http server
const clients = Object.create(null);

// proxy statistics
const stats = {
    tunnels: 0
};

//SLACK integration
let IncomingWebhook = require('@slack/client').IncomingWebhook;

let url = 'https://hooks.slack.com/services/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';

let webhook = new IncomingWebhook(url);


// handle proxying a request to a client
// will wait for a tunnel socket to become available
function maybe_bounce(req, res, sock, head) {
    // without a hostname, we won't know who the request is for
    const hostname = req.headers.host;
    if (!hostname) {
        console.log('no hostname, line 57');
        return false;
    }
    console.log("Hostname: " + hostname);

    let subdomain = tldjs.getSubdomain(hostname);
    if (!subdomain || subdomain === 'device') {
        console.log('no subdomain, line 64');
        return false;
    }

    subdomain = subdomain.split('.device')[0];

    const client = clients[subdomain];

    // no such subdomain
    // we use 502 error to the client to signify we can't service the request
    if (!client) {
        if (res) {
            console.log('no client, yes res, line 76');
            res.statusCode = 502;
            res.end(`no active client for '${subdomain}'`);
            req.connection.destroy();
        }
        else if (sock) {
            console.log('no client-res, yes sock, line 82');
            sock.destroy();
        }

        return true;
    }

    let finished = false;
    if (sock) {
        console.log('yes sock, line 91');
        sock.once('end', function() {
            finished = true;
        });
    }
    else if (res) {
        console.log('yes res, line 97');
        // flag if we already finished before we get a socket
        // we can't respond to these requests
        on_finished(res, function(err) {
            finished = true;
            req.connection.destroy();
        });
    }
    // not something we are expecting, need a sock or a res
    else {
        console.log('no res-sock, line 107');
        req.connection.destroy();
        return true;
    }

    // TODO add a timeout, if we run out of sockets, then just 502

    // get client port
    client.next_socket(async (socket) => {
        // the request already finished or client disconnected
        if (finished) {
            console.log('finished, line 118');
            return;
        }

        // happens when client upstream is disconnected (or disconnects)
        // and the proxy iterates the waiting list and clears the callbacks
        // we gracefully inform the user and kill their conn
        // without this, the browser will leave some connections open
        // and try to use them again for new requests
        // we cannot have this as we need bouncy to assign the requests again
        // TODO(roman) we could instead have a timeout above
        // if no socket becomes available within some time,
        // we just tell the user no resource available to service request
        else if (!socket) {
            if (res) {
                console.log('no socket, yes res, line 133');
                let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
                let toSlack = {
                    message: '504 was here',
                    useragent: {
                        os:  req.useragent.os,
                        browser: req.useragent.browser,
                        ip: ip
                    }
                };
                webhook.send(JSON.stringify(toSlack), function(err, header, statusCode, body) {
                    if (err) {
                        console.log('Error:', err);
                    } else {
                        console.log('Received', statusCode, 'from Slack');
                    }
                });

                res.statusCode = 504;
                res.end();
            }

            if (sock) {
                console.log('no socket, yes sock, line 156');
                sock.destroy();
            }

            req.connection.destroy();
            return;
        }

        // websocket requests are special in that we simply re-create the header info
        // and directly pipe the socket data
        // avoids having to rebuild the request and handle upgrades via the http client
        if (res === null) {
            console.log('no res, line 168');

            const arr = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            for (let i=0 ; i < (req.rawHeaders.length-1) ; i+=2) {
                arr.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}`);
            }

            arr.push('');
            arr.push('');

            socket.pipe(sock).pipe(socket);
            socket.write(arr.join('\r\n'));

            await new Promise((resolve) => {
                socket.once('end', resolve);
            });

            return;
        }

        // regular http request

        const agent = new BindingAgent({
            socket: socket
        });

        const opt = {
            path: req.url,
            agent: agent,
            method: req.method,
            headers: req.headers
        };

        await new Promise((resolve) => {
            // what if error making this request?
            const client_req = http.request(opt, function(client_res) {
                // write response code and headers
                res.writeHead(client_res.statusCode, client_res.headers);

                client_res.pipe(res);
                on_finished(client_res, function(err) {
                    resolve();
                });
            });

            // happens if the other end dies while we are making the request
            // so we just end the req and move on
            // we can't really do more with the response here because headers
            // may already be sent
            client_req.on('error', (err) => {
                req.connection.destroy();
            });

            req.pipe(client_req);
        });
    });

    return true;
}

// create a new tunnel with `id`
function new_client(id, opt, cb) {

    // can't ask for id already is use
    // TODO check this new id again
    if (clients[id]) {
        id = rand_id();
    }

    const popt = {
        id: id,
        max_tcp_sockets: opt.max_tcp_sockets
    };

    const client = Proxy(popt);

    // add to clients map immediately
    // avoiding races with other clients requesting same id
    clients[id] = client;

    client.on('end', function() {
        --stats.tunnels;
        delete clients[id];
    });

    client.start((err, info) => {
        if (err) {
            delete clients[id];
            cb(err);
            return;
        }

        ++stats.tunnels;

        info.id = id;
        cb(err, info);
    });
}

module.exports = function(opt) {
    opt = opt || {};

    const schema = opt.secure ? 'https' : 'http';

    const app = express();

    app.use(useragent.express());

    app.get('/', function(req, res, next) {
        if (req.query['new'] === undefined) {
            return next();
        }

        const req_id = rand_id();
        debug('making new client with id %s', req_id);
        new_client(req_id, opt, function(err, info) {
            if (err) {
                res.statusCode = 500;
                return res.end(err.message);
            }

            const url = schema + '://' + req_id + '.' + req.headers.host;
            info.url = url;
            res.json(info);
        });
    });

    app.get('/', function(req, res, next) {
        res.redirect('https://localtunnel.github.io/www/');
    });

    // TODO(roman) remove after deploying redirect above
    app.get('/assets/*', function(req, res, next) {
        proxy.web(req, res);
    });

    // TODO(roman) remove after deploying redirect above
    app.get('/favicon.ico', function(req, res, next) {
        proxy.web(req, res);
    });

    app.get('/api/status', function(req, res, next) {
        res.json({
            tunnels: stats.tunnels,
            mem: process.memoryUsage()
        });
    });

    app.get('/:req_id', function(req, res, next) {
        const req_id = req.params.req_id;

        // limit requested hostnames to 63 characters
        if (! /^[a-z0-9]{4,63}$/.test(req_id)) {
            const err = new Error('Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.');
            err.statusCode = 403;
            return next(err);
        }

        debug('making new client with id %s', req_id);
        new_client(req_id, opt, function(err, info) {
            if (err) {
                return next(err);
            }

            const url = schema + '://' + req_id + '.' + req.headers.host;
            info.url = url;
            res.json(info);
        });

    });

    app.use(function(err, req, res, next) {
        const status = err.statusCode || err.status || 500;
        res.status(status).json({
            message: err.message
        });
    });

    const server = http.createServer();

    server.on('request', function(req, res) {

        req.on('error', (err) => {
            console.error('request', err);
        });

        res.on('error', (err) => {
            console.error('response', err);
        });

        debug('request %s', req.url);
        if (maybe_bounce(req, res, null, null)) {
            return;
        };

        app(req, res);
    });

    server.on('upgrade', function(req, socket, head) {
        req.on('error', (err) => {
            console.error('ws req', err);
        });

        socket.on('error', (err) => {
            console.error('ws socket', err);
        });

        if (maybe_bounce(req, null, socket, head)) {
            return;
        };

        socket.destroy();
    });

    return server;
};
