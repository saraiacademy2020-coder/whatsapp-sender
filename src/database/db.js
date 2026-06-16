const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const collections = {};

function getFilePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function initCollection(name, defaults = []) {
  const fp = getFilePath(name);
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, JSON.stringify(defaults, null, 2), 'utf-8');
  }
  collections[name] = { name, filePath: fp };
}

function readAll(name) {
  const col = collections[name];
  if (!col) throw new Error(`Collection ${name} not found`);
  let data = fs.readFileSync(col.filePath, 'utf-8');
  if (data.charCodeAt(0) === 0xFEFF) data = data.slice(1);
  return JSON.parse(data);
}

function writeAll(name, data) {
  const col = collections[name];
  if (!col) throw new Error(`Collection ${name} not found`);
  const tmp = col.filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, col.filePath);
}

function find(name, predicate) {
  return readAll(name).filter(predicate);
}

function findOne(name, predicate) {
  return readAll(name).find(predicate) || null;
}

function insert(name, doc) {
  const data = readAll(name);
  data.push(doc);
  writeAll(name, data);
  return doc;
}

function update(name, predicate, updates) {
  const data = readAll(name);
  let count = 0;
  data.forEach((doc, i) => {
    if (predicate(doc)) {
      data[i] = { ...doc, ...updates, updatedAt: new Date().toISOString() };
      count++;
    }
  });
  if (count) writeAll(name, data);
  return count;
}

function remove(name, predicate) {
  const data = readAll(name);
  const before = data.length;
  const filtered = data.filter(d => !predicate(d));
  if (filtered.length !== before) writeAll(name, filtered);
  return before - filtered.length;
}

function paginate(name, { page = 1, limit = 50, filter = () => true, sort = null } = {}) {
  let data = readAll(name).filter(filter);
  if (sort) data.sort(sort);
  const total = data.length;
  const pages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const items = data.slice(start, start + limit);
  return { items, total, page, pages, limit };
}

module.exports = { initCollection, readAll, writeAll, find, findOne, insert, update, remove, paginate };
