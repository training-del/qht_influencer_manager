/* `HTTPS=1 node server/index.js` is not portable to Windows shells, so the
   flag is set here instead and the server started in-process. */
process.env.HTTPS = '1';
await import('../server/index.js');
