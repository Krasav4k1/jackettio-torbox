// Vercel serverless entrypoint. The Express app is a valid request handler, so exporting
// it as the default lets @vercel/node invoke it per-request. Long-running server startup
// (app.listen, background intervals, localtunnel) is skipped because process.env.VERCEL is set.
import app from '../src/index.js';

export default app;
