import path from 'path';

// Bundled font so text renders identically on any host (serverless included).
const FONT_PATH = path.join(import.meta.dirname, '../static/fonts/Outfit-Bold.ttf');
const FONT_FAMILY = 'TorBoxPoster';

// Canvas is a native module; load it lazily so a load failure (e.g. missing binary on a host)
// only disables generated posters — the caller falls back to the icon — instead of crashing boot.
let canvasMod = null;
let fontReady = false;
async function getCanvas(){
  if(!canvasMod){
    canvasMod = await import('@napi-rs/canvas');
    if(!fontReady){
      try { canvasMod.GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY); }catch(err){ console.log('poster font', err.message); }
      fontReady = true;
    }
  }
  return canvasMod;
}

// Deterministic 32-bit hash (FNV-1a) so the same title always gets the same color.
function hash32(str){
  let h = 2166136261 >>> 0;
  for(let i = 0; i < str.length; i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function escapeXml(str){
  return `${str}`.replace(/[<>&"']/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'}[c]));
}

// HSL (h in degrees, s/l in %) -> #rrggbb, so the SVG works in renderers without hsl() support.
function hslToHex(h, s, l){
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// Dependency-free SVG poster — same look as the PNG, used when native canvas is unavailable
// (e.g. serverless without the binary). Renders with the client's default sans font.
export function generatePosterSvg(title, subtitle){
  const W = 300, H = 450, pad = 24;
  const hue = hash32(title || '?') % 360;

  // Char-estimate word wrap (no measureText available), shrinking to fit <=5 lines.
  const words = `${title || 'Unknown'}`.split(/\s+/).filter(Boolean);
  let size = 34, lines = [];
  while(true){
    const maxChars = Math.max(6, Math.floor((W - pad * 2) / (size * 0.56)));
    lines = [];
    let line = '';
    for(const word of words){
      const test = line ? `${line} ${word}` : word;
      if(test.length <= maxChars || !line){
        line = test;
      }else{
        lines.push(line);
        line = word;
        if(lines.length === 5)break;
      }
    }
    if(line && lines.length < 5)lines.push(line);
    if(lines.length <= 4 || size <= 20)break;
    size -= 2;
  }

  const lineHeight = size * 1.16;
  let y = (H - lines.length * lineHeight) / 2 + size * 0.82;
  const tspans = lines.map((line, i) => `<tspan x="${W / 2}" y="${Math.round(y + i * lineHeight)}">${escapeXml(line)}</tspan>`).join('');
  const subEl = subtitle ? `<text x="${W / 2}" y="${Math.round(y + lines.length * lineHeight + 8)}" fill="rgba(255,255,255,0.62)" font-size="16" text-anchor="middle" font-family="sans-serif">${escapeXml(subtitle)}</text>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${hslToHex(hue, 42, 26)}"/><stop offset="1" stop-color="${hslToHex(hue, 46, 13)}"/></linearGradient></defs>`
    + `<rect width="${W}" height="${H}" fill="url(#g)"/>`
    + `<rect width="${W}" height="6" fill="${hslToHex(hue, 62, 58)}"/>`
    + `<text fill="#f6f5f3" font-size="${size}" font-weight="bold" text-anchor="middle" font-family="sans-serif">${tspans}</text>`
    + subEl
    + `<text x="${W / 2}" y="${H - 20}" fill="rgba(255,255,255,0.5)" font-size="13" text-anchor="middle" font-family="sans-serif">TorBox</text>`
    + `</svg>`;
}

function wrapLines(ctx, text, maxWidth, maxLines){
  const words = `${text}`.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for(const word of words){
    const test = line ? `${line} ${word}` : word;
    if(ctx.measureText(test).width <= maxWidth || !line){
      line = test;
    }else{
      lines.push(line);
      line = word;
      if(lines.length === maxLines){ line = ''; break; }
    }
  }
  if(line && lines.length < maxLines)lines.push(line);
  // If we ran out of lines but there is more text, ellipsize the last visible line.
  const rendered = lines.join(' ');
  if(rendered.replace(/\s+/g, ' ') !== words.join(' ') && lines.length){
    let last = lines[lines.length - 1];
    while(last.length && ctx.measureText(`${last}…`).width > maxWidth){
      last = last.slice(0, -1).trimEnd();
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

// Render a 2:3 PNG poster with the title on a title-derived colored background.
export async function generatePoster(title, subtitle){
  const {createCanvas} = await getCanvas();

  const W = 300, H = 450, pad = 24;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const hue = hash32(title || '?') % 360;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, `hsl(${hue}, 42%, 26%)`);
  bg.addColorStop(1, `hsl(${hue}, 46%, 13%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Top accent bar.
  ctx.fillStyle = `hsl(${hue}, 62%, 58%)`;
  ctx.fillRect(0, 0, W, 6);

  ctx.textAlign = 'center';

  // Fit the title: shrink font until it fits in <=5 lines.
  let size = 34;
  let lines;
  while(true){
    ctx.font = `${size}px ${FONT_FAMILY}`;
    lines = wrapLines(ctx, title || 'Unknown', W - pad * 2, 5);
    if(lines.length <= 4 || size <= 20)break;
    size -= 2;
  }
  ctx.font = `${size}px ${FONT_FAMILY}`;

  const lineHeight = size * 1.16;
  const blockH = lines.length * lineHeight;
  let y = (H - blockH) / 2 + size * 0.82;
  ctx.fillStyle = '#f6f5f3';
  for(const line of lines){
    ctx.fillText(line, W / 2, y);
    y += lineHeight;
  }

  if(subtitle){
    ctx.font = `16px ${FONT_FAMILY}`;
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.fillText(`${subtitle}`, W / 2, y + 10);
  }

  // Brand footer.
  ctx.font = `13px ${FONT_FAMILY}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('TorBox', W / 2, H - 20);

  return canvas.toBuffer('image/png');
}
