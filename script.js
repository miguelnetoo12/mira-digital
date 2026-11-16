(function(){
"use strict";

const $ = id => document.getElementById(id);
const stage = $("stage"), cv = $("cv");
let ctx = cv.getContext("2d");
// ===== Celular: detecção, desempenho automático e vibração =====
const IS_TOUCH = window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : ("ontouchstart" in window);
if(IS_TOUCH) document.body.classList.add("touch");
let LOW = false, perfAcc = 0, perfN = 0, DPR = 1;
function perfTick(dt){
  if(LOW) return;
  perfAcc += dt; perfN++;
  if(perfN >= 90){ if(perfAcc / perfN > 0.024){ LOW = true; resize(); } perfAcc = 0; perfN = 0; }   // abaixo de ~40 quadros/s: modo leve
}
function buzz(ms){ try{ if(navigator.vibrate) navigator.vibrate(ms); }catch(e){} }
const FX = () => LOW ? 0.4 : IS_TOUCH ? 0.7 : 1;                                                  // quantidade de partículas

const GAME_TIME = 60, MAX_AMMO = 8, RELOAD_T = 0.9;

let W = 0, H = 0, S = 1, slots = [], monitors = [];
function resize(){
  const r = stage.getBoundingClientRect();
  const dpr = DPR = Math.min(LOW ? 1 : IS_TOUCH ? 1.5 : 2, window.devicePixelRatio || 1);
  W = Math.max(1, r.width); H = Math.max(1, r.height);
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  S = Math.min(W / 9, H / 11);
  buildSlots();
  bgCache = null;
  if(state !== "play") draw();
}

// Posições onde os alvos aparecem (atrás de mesas e servidores)
function buildSlots(){
  slots = []; monitors = [];
  const nb = W < 520 ? 3 : 4, nf = W < 520 ? 2 : 3;
  const backY = H * 0.5, frontY = H * 0.8;
  for(let i = 0; i < nb; i++) slots.push({row:"back", x:W * (i + 0.5) / nb, coverY:backY, r:S * 0.62, busy:false});
  for(let i = 0; i < nf; i++) slots.push({row:"front", x:W * (i + 0.5) / nf + (nf === 2 ? 0 : 0), coverY:frontY, r:S * 0.9, busy:false});
  const nm = W < 520 ? 2 : 3;
  for(let i = 0; i < nm; i++) monitors.push({x:W * (i + 0.5) / nm, y:H * 0.24, w:Math.min(W / nm * 0.7, S * 3), h:S * 1.5, busy:false});
}

// ===== Estado =====
let state = "start";
let targets, effects, texts, score, timeLeft, ammo, reloading, shots, hits, friendsHit, combo, bestCombo, spawnT, cross, gunKick, flashRed;
let best = 0, muted = false;
try{ best = +(localStorage.getItem("mira-digital-best") || 0) || 0; muted = localStorage.getItem("mira-digital-mute") === "1"; }catch(e){}
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];

function reset(){
  targets = []; effects = []; texts = [];
  score = 0; timeLeft = GAME_TIME; ammo = MAX_AMMO; reloading = 0; shots = 0; hits = 0; friendsHit = 0; combo = 0; bestCombo = 0;
  spawnT = 0.5; cross = cross || {x:W / 2, y:H * 0.45, show:false}; gunKick = 0; flashRed = 0;
  for(const s of slots) s.busy = false;
  for(const m of monitors) m.busy = false;
}

// ===== Alvos =====
function spawn(){
  const elapsed = GAME_TIME - timeLeft, hard = Math.min(1, elapsed / GAME_TIME);
  const r = Math.random();
  if(r < 0.1 && !targets.some(t => t.kind === "drone")){
    const dir = Math.random() < 0.5 ? 1 : -1;
    targets.push({kind:"drone", x:dir > 0 ? -S : W + S, y:H * rnd(0.12, 0.3), vx:dir * W * rnd(0.22, 0.32) * (1 + hard * 0.6), r:S * 0.6, t:0});
    return;
  }
  if(r < 0.2){
    const free = monitors.filter(m => !m.busy);
    if(free.length){
      const m = pick(free); m.busy = true;
      targets.push({kind:"popup", m, x:m.x, y:m.y, r:Math.min(m.w, m.h) * 0.55, t:0, stay:rnd(1.4, 2) - hard * 0.5, up:0, state:"rise"});
      return;
    }
  }
  const free = slots.filter(s => !s.busy);
  if(!free.length) return;
  const s = pick(free); s.busy = true;
  const k = Math.random();
  const kind = k < 0.08 ? "gold" : k < 0.3 ? "friend" : "virus";
  const stay = kind === "gold" ? 0.75 : kind === "friend" ? rnd(1.3, 1.9) : rnd(1.2, 1.9) - hard * 0.55;
  targets.push({kind, s, x:s.x + rnd(-S * 0.3, S * 0.3), r:kind === "gold" ? s.r * 0.6 : s.r, t:0, stay, up:0, state:"rise"});
}

function targetY(t){
  if(t.kind === "drone") return t.y;
  if(t.kind === "popup") return t.y;
  return t.s.coverY - t.r * 1.15 * t.up;
}

const PTS = {virus:10, popup:15, drone:25, gold:50};

// ===== Tiro =====
function stagePoint(e){ const r = cv.getBoundingClientRect(); return {x:e.clientX - r.left, y:e.clientY - r.top}; }
function shoot(x, y){
  if(state !== "play") return;
  cross.x = x; cross.y = y; cross.show = true; cross.t = 0.5;
  if(reloading > 0) return;
  if(ammo <= 0){ sfx("empty"); float(x, y - 30, "Recarregue!", "#FFC93C"); $("btnReload").classList.add("pulse"); return; }
  ammo--; shots++; gunKick = 1; sfx("shot");
  effects.push({type:"beam", x, y, life:0.12});
  // procura do alvo mais próximo da câmera para o mais distante
  const order = ["front", "drone", "back", "popup"];
  let hit = null;
  for(const layer of order){
    for(const t of targets){
      if(t.dead) continue;
      const lay = t.kind === "drone" ? "drone" : t.kind === "popup" ? "popup" : t.s.row;
      if(lay !== layer) continue;
      const ty = targetY(t);
      if(t.kind !== "drone" && t.kind !== "popup" && y > t.s.coverY) continue;    // atrás da mesa não vale
      if(Math.hypot(x - t.x, y - ty) <= t.r * 1.05){ hit = t; break; }
    }
    if(hit) break;
  }
  if(!hit){ combo = 0; effects.push({type:"spark", x, y, life:0.25}); return; }
  hit.dead = true; release(hit);
  const ty = targetY(hit);
  if(hit.kind === "friend"){
    friendsHit++; combo = 0; score = Math.max(0, score - 30); flashRed = 0.35; sfx("bad"); buzz(120);
    float(hit.x, ty - hit.r, "Robô amigo! −30", "#FF6B7D");
    burst(hit.x, ty, "#5EC2FF", 16);
    return;
  }
  hits++; combo++; bestCombo = Math.max(bestCombo, combo);
  const mult = Math.min(4, 1 + Math.floor(combo / 5));
  const pts = PTS[hit.kind] * mult;
  score += pts;
  sfx(hit.kind === "gold" ? "gold" : "hit");
  float(hit.x, ty - hit.r, "+" + pts + (mult > 1 ? "  x" + mult : ""), hit.kind === "gold" ? "#FFC93C" : "#FFFFFF");
  burst(hit.x, ty, hit.kind === "gold" ? "#FFC93C" : hit.kind === "drone" ? "#FF6B7D" : hit.kind === "popup" ? "#FFFFFF" : "#4BE37A", 18);
}
function release(t){ if(t.s) t.s.busy = false; if(t.m) t.m.busy = false; }
function reload(){
  if(state !== "play" || reloading > 0 || ammo === MAX_AMMO) return;
  reloading = RELOAD_T; sfx("reload"); $("btnReload").classList.remove("pulse");
}

cv.addEventListener("pointerdown", e => {
  if(state !== "play") return;
  if(e.button === 2){ reload(); return; }
  const p = stagePoint(e); shoot(p.x, p.y);
});
cv.addEventListener("pointermove", e => { if(e.pointerType === "mouse"){ const p = stagePoint(e); cross.x = p.x; cross.y = p.y; cross.show = true; cross.t = 99; } });
cv.addEventListener("contextmenu", e => e.preventDefault());
$("btnReload").addEventListener("click", reload);
document.addEventListener("keydown", e => {
  if((state === "start" || state === "over") && (e.key === "Enter" || e.key === " ")){ e.preventDefault(); start(); return; }
  if(e.key === "p" || e.key === "P" || e.key === "Escape"){ togglePause(); return; }
  if(e.key === "r" || e.key === "R"){ reload(); }
});

// ===== Efeitos =====
function burst(x, y, color, n){ n = Math.round(n * FX()); for(let i = 0; i < n; i++){ const a = Math.random() * 6.28, v = rnd(60, 300); effects.push({type:"dot", x, y, vx:Math.cos(a) * v, vy:Math.sin(a) * v, life:rnd(0.3, 0.6), color}); } }
function float(x, y, text, color){ texts.push({x, y, text, color, life:0.9}); }

// ===== Som =====
let ac = null;
function sfx(kind){
  if(muted) return;
  try{
    if(!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    const P = {shot:["square",1200,300,0.08,0.05], hit:["triangle",700,1400,0.1,0.07], gold:["square",900,1900,0.25,0.06],
               bad:["sawtooth",220,80,0.35,0.1], empty:["square",160,140,0.05,0.05], reload:["triangle",300,700,0.25,0.07], end:["triangle",660,220,0.6,0.08]}[kind];
    if(!P) return;
    o.type = P[0]; o.frequency.setValueAtTime(P[1], t); o.frequency.exponentialRampToValueAtTime(P[2], t + P[3]);
    g.gain.setValueAtTime(P[4], t); g.gain.exponentialRampToValueAtTime(0.0001, t + P[3]);
    o.start(t); o.stop(t + P[3] + 0.02);
  }catch(e){}
}
function setMuteUI(){ $("btnSound").textContent = muted ? "🔇" : "🔊"; $("btnSound").setAttribute("aria-label", muted ? "Som desligado" : "Som ligado"); }
$("btnSound").addEventListener("click", () => { muted = !muted; setMuteUI(); try{ localStorage.setItem("mira-digital-mute", muted ? "1" : "0"); }catch(e){} });

// ===== Fluxo =====
function start(){
  reset(); state = "play";
  $("startScreen").hidden = true; $("overScreen").hidden = true; $("pauseScreen").hidden = true; $("hud").hidden = false; $("btnReload").hidden = false;
  last = performance.now();
  if(ac && ac.state === "suspended") ac.resume();
}
function togglePause(){
  if(state === "play"){ state = "pause"; $("pauseScreen").hidden = false; }
  else if(state === "pause"){ state = "play"; $("pauseScreen").hidden = true; last = performance.now(); }
}
function finish(){
  state = "over"; sfx("end"); $("btnReload").hidden = true;
  const rec = score > best;
  if(rec){ best = score; try{ localStorage.setItem("mira-digital-best", String(best)); }catch(e){} }
  const acc = shots ? Math.round(hits / shots * 100) : 0;
  $("overTitle").textContent = rec ? "Novo recorde!" : acc >= 80 ? "Mira de elite!" : "Fim da missão!";
  $("overTag").textContent = rec ? "Parabéns" : "Tempo esgotado";
  $("overScore").textContent = score.toLocaleString("pt-BR");
  $("overHits").textContent = hits;
  $("overAcc").textContent = acc + "%";
  $("overNote").textContent = (bestCombo >= 5 ? "Maior sequência: " + bestCombo + " acertos seguidos. " : "") +
    (friendsHit ? "Você acertou " + friendsHit + " robô" + (friendsHit > 1 ? "s" : "") + " amigo" + (friendsHit > 1 ? "s" : "") + "!" : "Nenhum robô amigo atingido. 👏");
  $("overBest").textContent = "Recorde: " + best.toLocaleString("pt-BR");
  $("overScreen").hidden = false;
  $("btnAgain").focus({preventScroll:true});
}
$("btnPlay").addEventListener("click", start);
$("btnAgain").addEventListener("click", start);
$("btnPause").addEventListener("click", togglePause);
$("btnResume").addEventListener("click", togglePause);
document.addEventListener("visibilitychange", () => { if(document.hidden && state === "play") togglePause(); });

// ===== Atualização =====
function update(dt){
  timeLeft -= dt;
  if(timeLeft <= 0){ timeLeft = 0; updateHud(); finish(); return; }
  const hard = Math.min(1, (GAME_TIME - timeLeft) / GAME_TIME);
  spawnT -= dt;
  if(spawnT <= 0){ spawn(); spawnT = rnd(0.45, 0.85) - hard * 0.25; }

  for(const t of targets){
    t.t += dt;
    if(t.kind === "drone"){ t.x += t.vx * dt; t.y += Math.sin(t.t * 4) * S * 0.6 * dt; if(t.x < -S * 2 || t.x > W + S * 2) t.dead = true; continue; }
    if(t.state === "rise"){ t.up = Math.min(1, t.up + dt * 6); if(t.up >= 1){ t.state = "hold"; t.t = 0; } }
    else if(t.state === "hold"){ if(t.t > t.stay){ t.state = "fall"; } }
    else { t.up -= dt * 5; if(t.up <= 0){ t.dead = true; release(t); if(t.kind !== "friend" && t.kind !== "popup") combo = combo; } }
  }
  targets = targets.filter(t => !t.dead);

  if(reloading > 0){ reloading -= dt; if(reloading <= 0){ reloading = 0; ammo = MAX_AMMO; } }
  if(gunKick > 0) gunKick = Math.max(0, gunKick - dt * 8);
  if(flashRed > 0) flashRed -= dt;
  if(cross.t !== undefined && cross.t < 99){ cross.t -= dt; if(cross.t <= 0) cross.show = false; }
  for(const f of effects){ f.life -= dt; if(f.type === "dot"){ f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 500 * dt; } }
  effects = effects.filter(f => f.life > 0);
  for(const t of texts){ t.y -= 40 * dt; t.life -= dt; }
  texts = texts.filter(t => t.life > 0);
  updateHud();
}
function updateHud(){
  $("hudScore").textContent = score.toLocaleString("pt-BR");
  $("hudTime").textContent = Math.ceil(timeLeft);
  $("hudAmmo").textContent = reloading > 0 ? "…" : ammo + "/" + MAX_AMMO;
  $("btnReload").textContent = reloading > 0 ? "Recarregando…" : "↻ Recarregar";
}

// ===== Desenho =====
function rr(x, y, w, h, r){ ctx.beginPath(); if(ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }

function drawRoom(){
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0A1F57"); g.addColorStop(0.55, "#12347F"); g.addColorStop(0.56, "#0B2260"); g.addColorStop(1, "#071A4B");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // racks de servidor ao fundo
  const rw = S * 1.1;
  for(let x = S * 0.2; x < W; x += rw + S * 0.25){
    ctx.fillStyle = "#0B2260"; ctx.fillRect(x, H * 0.08, rw, H * 0.48);
    ctx.fillStyle = "#081A4D";
    for(let y = H * 0.1; y < H * 0.54; y += S * 0.32){
      ctx.fillRect(x + S * 0.08, y, rw - S * 0.16, S * 0.22);
      ctx.fillStyle = Math.random() < 0.02 ? "#4BE3A1" : "rgba(94,194,255,.65)";
      ctx.fillRect(x + S * 0.14, y + S * 0.08, S * 0.06, S * 0.06);
      ctx.fillStyle = "#081A4D";
    }
  }
  // monitores
  for(const m of monitors){
    ctx.fillStyle = "#061541"; rr(m.x - m.w / 2 - 6, m.y - m.h / 2 - 6, m.w + 12, m.h + 12, 8); ctx.fill();
    ctx.fillStyle = "#12347F"; ctx.fillRect(m.x - m.w / 2, m.y - m.h / 2, m.w, m.h);
    ctx.fillStyle = "rgba(94,194,255,.25)";
    for(let i = 0; i < 4; i++) ctx.fillRect(m.x - m.w / 2 + 8, m.y - m.h / 2 + 10 + i * m.h * 0.2, m.w * (0.3 + ((i * 37) % 50) / 100), 4);
  }
}

// fundo desenhado uma vez só (mais leve no celular)
let bgCache = null;
function drawRoomCached(){
  if(!bgCache){
    const c = document.createElement("canvas"); c.width = Math.round(W * DPR); c.height = Math.round(H * DPR);
    const g = c.getContext("2d"); g.setTransform(DPR, 0, 0, DPR, 0, 0);
    const main = ctx; ctx = g; drawRoom(); ctx = main;
    bgCache = c;
  }
  ctx.drawImage(bgCache, 0, 0, W, H);
}

function drawDesk(row){
  const y = row === "back" ? H * 0.5 : H * 0.8, h = row === "back" ? S * 0.9 : H - y;
  ctx.fillStyle = row === "back" ? "#1B3C8F" : "#2A55B8";
  ctx.fillRect(0, y, W, h);
  ctx.fillStyle = "#5EC2FF"; ctx.fillRect(0, y, W, row === "back" ? 3 : 5);
  // detalhes: teclados e cabos
  ctx.fillStyle = row === "back" ? "#12347F" : "#1B3C8F";
  for(let x = S * 0.4; x < W; x += S * 2.2) ctx.fillRect(x, y + h * 0.25, S * 1.2, Math.max(4, h * 0.12));
}

function drawTarget(t){
  const y = targetY(t), r = t.r;
  ctx.save(); ctx.translate(t.x, y);
  if(t.kind === "virus"){
    ctx.strokeStyle = "#1E8A45"; ctx.lineWidth = r * 0.14; ctx.lineCap = "round";
    for(let i = 0; i < 10; i++){ const a = i / 10 * 6.28 + t.t; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8); ctx.lineTo(Math.cos(a) * r * 1.15, Math.sin(a) * r * 1.15); ctx.stroke(); }
    ctx.fillStyle = "#4BE37A"; ctx.beginPath(); ctx.arc(0, 0, r * 0.85, 0, 7); ctx.fill();
    face(r, "#0B3A1C", true);
    target(r);
  } else if(t.kind === "gold"){
    ctx.rotate(t.t * 4);
    ctx.fillStyle = "#FFC93C"; ctx.fillRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4);
    ctx.fillStyle = "#B7791F"; ctx.fillRect(-r * 0.32, -r * 0.32, r * 0.64, r * 0.64);
    ctx.strokeStyle = "#FFC93C"; ctx.lineWidth = r * 0.12;
    for(const d of [-0.35, 0, 0.35]){ ctx.beginPath(); ctx.moveTo(-r, d * r); ctx.lineTo(r, d * r); ctx.moveTo(d * r, -r); ctx.lineTo(d * r, r); ctx.stroke(); }
  } else if(t.kind === "friend"){
    ctx.fillStyle = "#FFFFFF"; rr(-r * 0.85, -r * 0.8, r * 1.7, r * 1.55, r * 0.35); ctx.fill();
    ctx.fillStyle = "#5EC2FF"; rr(-r * 0.6, -r * 0.5, r * 1.2, r * 0.7, r * 0.2); ctx.fill();
    ctx.fillStyle = "#0A1F57"; ctx.beginPath(); ctx.arc(-r * 0.25, -r * 0.18, r * 0.11, 0, 7); ctx.arc(r * 0.25, -r * 0.18, r * 0.11, 0, 7); ctx.fill();
    ctx.strokeStyle = "#0A1F57"; ctx.lineWidth = r * 0.08; ctx.beginPath(); ctx.arc(0, -r * 0.02, r * 0.2, 0.2, Math.PI - 0.2); ctx.stroke();
    ctx.strokeStyle = "#CFE6FF"; ctx.lineWidth = r * 0.08; ctx.beginPath(); ctx.moveTo(0, -r * 0.8); ctx.lineTo(0, -r * 1.1); ctx.stroke();
    ctx.fillStyle = "#4BE3A1"; ctx.beginPath(); ctx.arc(0, -r * 1.15, r * 0.12, 0, 7); ctx.fill();
    ctx.fillStyle = "#4BE3A1"; ctx.font = "800 " + Math.round(r * 0.32) + "px Archivo, Arial Black, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("AMIGO", 0, r * 0.5);
  } else if(t.kind === "popup"){
    const m = t.m, s = t.up, w = m.w * s, h = m.h * s;
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = "#FF6B7D"; ctx.fillRect(-w / 2, -h / 2, w, h * 0.22);
    if(s > 0.6){
      ctx.fillStyle = "#FFFFFF"; ctx.font = "800 " + Math.round(h * 0.15) + "px Inter, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText("✕", w / 2 - 6, -h / 2 + h * 0.11);
      ctx.fillStyle = "#B42335"; ctx.textAlign = "center"; ctx.font = "900 " + Math.round(h * 0.2) + "px Archivo, Arial Black, sans-serif";
      ctx.fillText("VOCÊ GANHOU!", 0, h * 0.02);
      ctx.fillStyle = "#1C5FD6"; ctx.font = "700 " + Math.round(h * 0.13) + "px Inter, sans-serif";
      ctx.fillText("clique aqui ▸", 0, h * 0.28);
    }
  } else if(t.kind === "drone"){
    ctx.strokeStyle = "#CFE6FF"; ctx.lineWidth = r * 0.08;
    for(const s of [-1, 1]){ ctx.beginPath(); ctx.moveTo(s * r * 0.4, -r * 0.2); ctx.lineTo(s * r * 1.0, -r * 0.5); ctx.stroke();
      ctx.fillStyle = "rgba(207,230,255,.5)"; ctx.beginPath(); ctx.ellipse(s * r * 1.0, -r * 0.55, r * 0.45 * Math.abs(Math.sin(t.t * 30)) + r * 0.1, r * 0.08, 0, 0, 7); ctx.fill(); }
    ctx.fillStyle = "#FF6B7D"; rr(-r * 0.6, -r * 0.35, r * 1.2, r * 0.7, r * 0.2); ctx.fill();
    ctx.fillStyle = "#3A0710"; ctx.beginPath(); ctx.arc(0, 0, r * 0.22, 0, 7); ctx.fill();
    ctx.fillStyle = "#FFC93C"; ctx.beginPath(); ctx.arc(0, 0, r * 0.1, 0, 7); ctx.fill();
  }
  ctx.restore();
}
function face(r, c, angry){
  ctx.fillStyle = "#FFFFFF"; ctx.beginPath(); ctx.arc(-r * 0.28, -r * 0.1, r * 0.19, 0, 7); ctx.arc(r * 0.28, -r * 0.1, r * 0.19, 0, 7); ctx.fill();
  ctx.fillStyle = c; ctx.beginPath(); ctx.arc(-r * 0.25, -r * 0.06, r * 0.09, 0, 7); ctx.arc(r * 0.25, -r * 0.06, r * 0.09, 0, 7); ctx.fill();
  if(angry){ ctx.strokeStyle = c; ctx.lineWidth = r * 0.08; ctx.beginPath(); ctx.moveTo(-r * 0.5, -r * 0.38); ctx.lineTo(-r * 0.1, -r * 0.24); ctx.moveTo(r * 0.5, -r * 0.38); ctx.lineTo(r * 0.1, -r * 0.24); ctx.stroke(); }
}
function target(r){ ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, r * 1.25, 0, 7); ctx.stroke(); }

function drawGun(){
  const gx = W < 520 ? W * 0.42 : W * 0.6, gy = H + S * 0.2;
  const ang = Math.atan2(cross.y - gy, cross.x - gx);
  ctx.save(); ctx.translate(gx, gy); ctx.rotate(ang + Math.PI / 2);
  const k = gunKick * S * 0.25;
  ctx.fillStyle = "#CFE6FF"; rr(-S * 0.35, -S * 1.9 + k, S * 0.7, S * 1.9, S * 0.15); ctx.fill();
  ctx.fillStyle = "#5EC2FF"; ctx.fillRect(-S * 0.22, -S * 1.75 + k, S * 0.44, S * 0.25);
  ctx.fillStyle = "#12347F"; rr(-S * 0.5, -S * 0.8 + k, S * 1.0, S * 1.1, S * 0.2); ctx.fill();
  ctx.restore();
  return {gx, gy, ang};
}

function draw(){
  ctx.save();
  drawRoomCached();
  if(targets){
    for(const t of targets) if(t.kind === "popup") drawTarget(t);
    for(const t of targets) if(t.kind === "drone") drawTarget(t);
    for(const t of targets) if(t.s && t.s.row === "back") drawTarget(t);
    drawDesk("back");
    for(const t of targets) if(t.s && t.s.row === "front") drawTarget(t);
    drawDesk("front");
    // efeitos
    const g = state === "start" ? null : drawGun();
    for(const f of effects){
      if(f.type === "beam" && g){
        ctx.strokeStyle = "rgba(94,194,255," + (f.life * 7).toFixed(2) + ")"; ctx.lineWidth = 5; ctx.lineCap = "round";
        const mx = g.gx + Math.cos(g.ang) * S * 1.8, my = g.gy + Math.sin(g.ang) * S * 1.8;
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(f.x, f.y); ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,255," + (f.life * 7).toFixed(2) + ")"; ctx.lineWidth = 2; ctx.stroke();
      } else if(f.type === "spark"){
        ctx.strokeStyle = "rgba(255,201,60," + (f.life * 4).toFixed(2) + ")"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(f.x, f.y, (0.25 - f.life) * 60 + 4, 0, 7); ctx.stroke();
      } else if(f.type === "dot"){
        ctx.globalAlpha = Math.max(0, f.life * 2); ctx.fillStyle = f.color; ctx.fillRect(f.x, f.y, 4, 4); ctx.globalAlpha = 1;
      }
    }
    for(const t of texts){
      ctx.globalAlpha = Math.min(1, t.life * 2);
      ctx.font = "900 " + Math.round(Math.max(16, S * 0.42)) + "px Archivo, Arial Black, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.lineWidth = 5; ctx.strokeStyle = "#061541"; ctx.strokeText(t.text, t.x, t.y); ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y);
      ctx.globalAlpha = 1;
    }
    // mira
    if(cross.show && state === "play"){
      const c = reloading > 0 ? "#FFC93C" : "#FFFFFF", R = S * 0.42;
      ctx.strokeStyle = c; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cross.x, cross.y, R, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cross.x - R * 1.5, cross.y); ctx.lineTo(cross.x - R * 0.4, cross.y); ctx.moveTo(cross.x + R * 0.4, cross.y); ctx.lineTo(cross.x + R * 1.5, cross.y);
      ctx.moveTo(cross.x, cross.y - R * 1.5); ctx.lineTo(cross.x, cross.y - R * 0.4); ctx.moveTo(cross.x, cross.y + R * 0.4); ctx.lineTo(cross.x, cross.y + R * 1.5); ctx.stroke();
      ctx.fillStyle = "#FF6B7D"; ctx.beginPath(); ctx.arc(cross.x, cross.y, 3, 0, 7); ctx.fill();
    }
    // últimos 10 segundos
    if(state === "play" && timeLeft <= 10){
      ctx.fillStyle = "rgba(255,107,125," + (0.12 + 0.1 * Math.sin(timeLeft * 10)).toFixed(2) + ")"; ctx.fillRect(0, 0, W, 6); ctx.fillRect(0, H - 6, W, 6);
    }
  }
  if(flashRed > 0){ ctx.fillStyle = "rgba(255,107,125," + (flashRed).toFixed(2) + ")"; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
}

let last = performance.now();
function loop(now){
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if(state === "play"){ update(dt); perfTick(dt); }
  if(state !== "pause") draw();
}

setMuteUI();
$("bestStart").textContent = "Recorde: " + best.toLocaleString("pt-BR");
cross = {x:0, y:0, show:false};
new ResizeObserver(resize).observe(stage);
resize();
reset();
// alguns alvos de enfeite na tela inicial
if(slots.length){ targets.push({kind:"virus", s:slots[0], x:slots[0].x, r:slots[0].r, t:0, stay:99, up:1, state:"hold"}); targets.push({kind:"friend", s:slots[slots.length - 1], x:slots[slots.length - 1].x, r:slots[slots.length - 1].r, t:0, stay:99, up:1, state:"hold"}); }
requestAnimationFrame(loop);
})();
