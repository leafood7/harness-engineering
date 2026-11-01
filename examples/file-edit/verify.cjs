const assert = require('node:assert/strict');
const path = require('node:path');
const calc = require(path.join(process.cwd(), 'calc.cjs'));
assert.equal(calc.add(2, 3), 5);
assert.equal(calc.add(-2, 5), 3);
assert.equal(calc.add(0, 0), 0);
assert.equal(calc.add(1.5, 2.25), 3.75);
console.log('Four arithmetic acceptance cases passed.');
