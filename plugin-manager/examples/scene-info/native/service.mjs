/** Minimal read-only native service. Started and stopped by Plugin Manager. */
import http from 'node:http';

const argument = name => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
};
const port = Number(argument('--port'));
const editorOrigin = argument('--editor-origin');
if (!process.connected || !Number.isInteger(port) || port < 1024 || port > 65535 ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(editorOrigin || '')) {
    throw new Error('Start this service through Plugin Manager with an assigned port and Editor origin.');
}

// No filesystem access, arbitrary commands, or external dependencies.
const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== editorOrigin) {
        res.writeHead(403).end();
        return;
    }
    res.setHeader('Access-Control-Allow-Origin', editorOrigin);
    res.setHeader('Vary', 'Origin');
    if (req.url !== '/info') { res.writeHead(404).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ node: process.version, platform: process.platform, pid: process.pid }));
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;

let stopping = false;
function stop() {
    if (stopping) return;
    stopping = true;
    server.close(() => { if (process.connected) process.disconnect(); });
    server.closeAllConnections();
}
process.on('message', message => { if (message?.type === 'native-stop') stop(); });
process.on('disconnect', stop);
server.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
    if (error.code === 'EADDRINUSE' && process.connected) {
        process.send({ type: 'native-start-error', code: 'PORT_IN_USE', port }, stop);
    } else stop();
});
server.listen(port, '127.0.0.1', () => {
    if (!stopping && process.connected) process.send({ type: 'native-ready', port: server.address().port });
});
