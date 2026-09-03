'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// Fixed "now" so open-position interest/days-held assertions are deterministic:
// 2025-01-10 10:00 IST == 04:30 UTC. Trades dated 2025-01-01 are exactly 9 days old.
const FIXED_NOW_MS = Date.UTC(2025, 0, 10, 4, 30, 0);

// Loads the browser-global app sources (config, calculator, dataHandler) into one
// vm context with a fixed Date and an injectable fetch, mirroring how index.html
// loads them as plain script tags.
function loadApp({ nowMs = FIXED_NOW_MS, fetch } = {}) {
    const RealDate = Date;
    class FixedDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(nowMs);
            else super(...args);
        }
        static now() {
            return nowMs;
        }
    }

    const sandbox = {
        console,
        window: {},
        Date: FixedDate,
        fetch: fetch || (() => Promise.reject(new Error('fetch not stubbed')))
    };

    const code = [
        fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'),
        fs.readFileSync(path.join(ROOT, 'calculator.js'), 'utf8'),
        fs.readFileSync(path.join(ROOT, 'dataHandler.js'), 'utf8')
    ].join('\n');

    const context = vm.createContext(sandbox);
    vm.runInContext(code, context, { filename: 'app-sources.js' });
    return context;
}

// Evaluate an expression inside the app context and return its completion value.
function run(ctx, expression) {
    return vm.runInContext(expression, ctx);
}

// Evaluate an expression and JSON-decode it so sandbox values (Dates, etc.)
// become plain data the host test runner can assert on.
function json(ctx, expression) {
    return JSON.parse(run(ctx, `JSON.stringify(${expression})`));
}

// Like json(), but awaits an async sandbox expression (returns a Promise).
async function jsonAsync(ctx, expression) {
    return JSON.parse(await run(ctx, `(${expression}).then(v => JSON.stringify(v))`));
}

module.exports = { loadApp, run, json, jsonAsync, FIXED_NOW_MS };
