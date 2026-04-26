const fs = require('fs');
const path = require('path');

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function loadTextNoComments(filePath, fallback = '') {
  return loadText(filePath, fallback).replace(/^#.*$/gm, '').trim();
}

function loadSet(filePath) {
  try {
    return new Set(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveSet(filePath, set) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify([...set]));
}

module.exports = { loadJSON, saveJSON, loadText, loadTextNoComments, loadSet, saveSet };
