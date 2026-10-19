import { handleRequest, initServer } from './server.js';

let readyPromise = null;

export default async function handler(req, res) {
  if (!readyPromise) {
    readyPromise = initServer();
  }
  await readyPromise;
  return handleRequest(req, res);
}
