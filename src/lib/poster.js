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
