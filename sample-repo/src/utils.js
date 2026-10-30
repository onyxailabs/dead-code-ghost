function add(a, b) {
  return a + b;
}

function greet(name) {
  return 'hi ' + name;
}

// Never called anywhere in this sample repo.
function oldHelper() {
  return 'old';
}

// Never called anywhere in this sample repo.
function unusedCalc(x) {
  return x * 2;
}

// Exported, so outside code may use it — review candidate, not confirmed dead.
function publicApi() {
  return 'api';
}

class Worker {
  run() {
    return 1;
  }

  // Never called anywhere in this sample repo.
  idle() {
    return 0;
  }
}

const w = new Worker();
w.run();

module.exports = { add, greet, publicApi };
