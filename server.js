const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Data (in-memory, hilang kalau server restart) ----------
const users = new Map();    // name -> { name, sockets:Set }
const groups = new Map();   // id -> { id, name, members:Set, owner }
const history = new Map();  // chatKey -> [messages]
let groupCounter = 1;

groups.set('umum', { id: 'umum', name: 'Grup Umum', members: new Set(), owner: null });

const pKey = (a, b) => 'p:' + [a, b].sort().join('|');
const gKey = (id) => 'g:' + id;

function push(key, msg) {
  if (!history.has(key)) history.set(key, []);
  const arr = history.get(key);
  arr.push(msg);
  if (arr.length > 500) arr.shift();
}

const userList = () =>
  [...users.values()].map((u) => ({ name: u.name, online: u.sockets.size > 0 }));
const groupView = (g) => ({ id: g.id, name: g.name, members: [...g.members], owner: g.owner });
const groupsOf = (name) => [...groups.values()].filter((g) => g.members.has(name)).map(groupView);
const clean = (t) => String(t || '').trim().slice(0, 2000);

io.on('connection', (socket) => {
  let me = null;

  socket.on('login', (rawName, cb) => {
    const name = String(rawName || '').trim();
    if (name.length < 2 || name.length > 20) return cb({ ok: false, error: 'Username harus 2-20 karakter' });
    const existing = users.get(name);
    if (existing && existing.sockets.size > 0) return cb({ ok: false, error: 'Username sedang dipakai orang lain' });

    me = name;
    if (!existing) users.set(name, { name, sockets: new Set() });
    users.get(name).sockets.add(socket.id);

    socket.join('user:' + name);
    groups.get('umum').members.add(name);
    for (const g of groups.values()) if (g.members.has(name)) socket.join('group:' + g.id);

    cb({ ok: true, me, users: userList(), groups: groupsOf(name) });
    io.emit('users', userList());
    io.to('group:umum').emit('groups_update', groupView(groups.get('umum')));
  });

  socket.on('get_history', ({ type, id }, cb) => {
    if (!me) return;
    if (type === 'p') return cb(history.get(pKey(me, id)) || []);
    const g = groups.get(id);
    if (g && g.members.has(me)) return cb(history.get(gKey(id)) || []);
    cb([]);
  });

  socket.on('private_message', ({ to, text }) => {
    if (!me || !users.has(to)) return;
    text = clean(text);
    if (!text) return;
    const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), type: 'p', from: me, to, text, time: Date.now() };
    push(pKey(me, to), msg);
    io.to('user:' + to).to('user:' + me).emit('message', msg);
  });

  socket.on('group_message', ({ groupId, text }) => {
    const g = groups.get(groupId);
    if (!me || !g || !g.members.has(me)) return;
    text = clean(text);
    if (!text) return;
    const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), type: 'g', from: me, groupId, text, time: Date.now() };
    push(gKey(groupId), msg);
    io.to('group:' + groupId).emit('message', msg);
  });

  socket.on('create_group', ({ name, members }, cb) => {
    if (!me) return;
    name = String(name || '').trim().slice(0, 30);
    if (!name) return cb({ ok: false, error: 'Nama grup kosong' });
    const set = new Set([me, ...(members || []).filter((m) => users.has(m))]);
    if (set.size < 2) return cb({ ok: false, error: 'Pilih minimal 1 anggota' });

    const id = 'g' + groupCounter++;
    const g = { id, name, members: set, owner: me };
    groups.set(id, g);
    for (const m of set) {
      const u = users.get(m);
      if (!u) continue;
      for (const sid of u.sockets) io.sockets.sockets.get(sid)?.join('group:' + id);
    }
    const notice = { id: 'sys-' + id, type: 'g', from: 'sistem', groupId: id, text: `${me} membuat grup "${name}"`, time: Date.now(), system: true };
    push(gKey(id), notice);
    io.to('group:' + id).emit('group_created', groupView(g));
    io.to('group:' + id).emit('message', notice);
    cb({ ok: true, id });
  });

  socket.on('typing', ({ type, id }) => {
    if (!me) return;
    if (type === 'p') io.to('user:' + id).emit('typing', { type, id: me, from: me });
    else io.to('group:' + id).except('user:' + me).emit('typing', { type, id, from: me });
  });

  // Signaling telpon (WebRTC) - hanya 1-ke-1
  socket.on('call:signal', ({ to, type, data }) => {
    if (!me || !users.has(to)) return;
    io.to('user:' + to).emit('call:signal', { from: me, type, data });
  });

  socket.on('disconnect', () => {
    if (!me) return;
    const u = users.get(me);
    if (u) u.sockets.delete(socket.id);
    io.emit('users', userList());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chat jalan di http://localhost:${PORT}`));