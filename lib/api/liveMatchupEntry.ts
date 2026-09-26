import { handleLiveMatchupRequest } from './liveMatchupRoute.ts';

export default async function handler(req: { method: string; url: string; headers: Record<string, string> }, res: {
  status(code: number): typeof res;
  setHeader(name: string, value: string): void;
  send(body: string): void;
}) {
  const result = await handleLiveMatchupRequest(new Request(`https://fsn.local${req.url}`, {
    method: req.method, headers: req.headers
  }));
  res.status(result.status);
  result.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(await result.text());
}
