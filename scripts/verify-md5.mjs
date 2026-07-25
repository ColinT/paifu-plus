import { md5hex } from '../src/pdf/md5.ts';
import crypto from 'node:crypto';
const enc = (s) => new TextEncoder().encode(s);
let ok = true;
for (const s of ['', 'abc', 'The quick brown fox jumps over the lazy dog', 'mahjong牌譜']) {
  const mine = md5hex(enc(s));
  const node = crypto.createHash('md5').update(Buffer.from(enc(s))).digest('hex');
  if (mine !== node) ok = false;
  console.log(mine === node ? 'OK  ' : 'FAIL', JSON.stringify(s.slice(0, 20)), mine);
}
const rnd = crypto.randomBytes(5000);
const r = md5hex(new Uint8Array(rnd)) === crypto.createHash('md5').update(rnd).digest('hex');
if (!r) ok = false;
console.log(r ? 'OK   random-5000' : 'FAIL random-5000');
console.log(ok ? '\nALL MATCH' : '\nMISMATCH');
