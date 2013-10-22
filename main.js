/*global maybe: true*/
var maybe = require('./maybe');
var _     = require('lodash');
var util  = require('util');

const PAR = 'par';
const SEQ = 'seq';
const ERR = 'err';

var Seq = module.exports = function Seq(initialStack) {
  if (this instanceof Seq) {
    var self = this;
    this.stack = [];
    this.queue = [];
    this.concurrencyLevel = 0;
    this.args = maybe(initialStack).kindOf(Array).getOrElse([]);
    process.nextTick(function waitForStack() {
      if (self.stack.length)
        self.conveyor();
      else
        setImmediate(waitForStack);
    });
  } else {
    console.log('creating new instance of Seq');
    return new Seq();
  }
};


//Handlers-----------------------------------------------------------------

Seq.prototype.handlersMap = {};

Seq.prototype.handlersMap[SEQ] = function (self, currItem) {
  currItem = self.stack.shift();
  executor(currItem, self, currItem.context);
};

Seq.prototype.handlersMap[PAR] = function (self, currItem) {
  while (self.stack.length && self.stack[0].type == PAR) {
    currItem = self.stack.shift();
    if (self.concurrencyLevel >= currItem.limit)
      self.queue.push(currItem);
    else
      executor(currItem, self, currItem.context, true);
  }
  console.log('emptying the args stack');
  self.args = [];
};

Seq.prototype.handlersMap[ERR] = function (self) {
  self.conveyor(self.stack.shift()); //Err handler shouldn't be executed in order, so skip current step
};


//System methods-------------------------------------------------------------------------

Seq.prototype.conveyor = function () {
  var currItem = this.stack[0];
  if (currItem)
    this.handlersMap[currItem.type](this, currItem);
};

var executor = function (currItem, self, context, merge) { //TODO maybe we need to optimize use of nextTick/setImmediate
  self.concurrencyLevel++;
  var cb = function (e) {
    self.concurrencyLevel--;
    if (e) {
      return self.errHandler(e);
    } else {
      var ret = Array.prototype.slice.call(arguments, 1);
      if (merge)
        self.args[currItem.position] = ret.length > 1 ? ret:ret[0];
      else
        self.args = ret;
    }
    if (self.queue.length) {
      var newItem = self.queue.pop();
      return executor(newItem, self, newItem.context, true);
    }
    if (!self.concurrencyLevel)
      process.nextTick(function () {
        self.conveyor();
      });
  };
  cb.vars = self.args;
  process.nextTick((function (cb, args) {
    if (context)
      args.push(cb);
    return function () {
      currItem.fn.apply(context || cb, args);
    };
  })(cb, self.args.slice()));
};

Seq.prototype.errHandler = function (e) {
  var currItem = {};
  while (currItem && currItem.type !== ERR)
    currItem = this.stack.shift(this.args.shift()); //looking for closest error handler. Just shifting the args - we don't need them anymore
  (currItem ? currItem.fn : function (e) { throw e; })(e);
};


//Interface methods--------------------------------------------------------------------------------------------------------------------------

Seq.prototype.seq = function (fn) {
  this.stack.push({fn: fn, type: SEQ});
  return this;
};

Seq.prototype.sq_ = function (fn) {
  return this.seq(fn).context(fn);
};

Seq.prototype.par = function (fn) {
  if (this.stack.length && this.stack[this.stack.length - 1].type == PAR)
    this.stack.push({fn: fn, type: PAR, position: this.stack[this.stack.length - 1].position + 1});
  else
    this.stack.push({fn: fn, type: PAR, position: 0});
  return this;
};

Seq.prototype.pr_ = function (fn) {
  return this.par(fn).context(fn);
};

Seq.prototype.catch = function (fn) {
  this.stack.push({fn: fn, type: ERR});
  return this;
};

Seq.prototype.limit = function (limit) {
  if (this.stack.length)
    this.stack[this.stack.length - 1].limit = limit;
  return this;
};

Seq.prototype.context = function (context) {
  if (this.stack.length)
    this.stack[this.stack.length - 1].context = context;
  return this;
};

Seq.prototype.forEach = function (fn) {
  return this.seq(function () {
    var subseq = Seq();
    var args = Array.prototype.slice.call(arguments);
    args.forEach(function (item, index) {
      subseq.par(function () {
        fn.call(this, item, index);
      });
    });
    subseq.catch(this);
    this.apply(this, [null].concat(args));
  });
};

Seq.prototype.seqEach = function (fn) {
  return this.seq(function () {
    var self = this;
    var subseq = Seq();
    var args = Array.prototype.slice.call(arguments);
    args.forEach(function (item, index) {
      subseq.seq(function () {
        fn.call(this, item, index);
      });
    });
    subseq.seq(function () {
      this(null, self.apply(self, [null].concat(args)));
    }).catch(this);
  });
};

Seq.prototype.parEach = function (limit, fn) {
  fn = maybe(fn).kindOf(Function).getOrElse(limit);
  limit = maybe(limit).kindOf(Number).getOrElse(Infinity);
  return this.seq(function () {
    var self = this;
    var subseq = Seq();
    var args = Array.prototype.slice.call(arguments);
    args.forEach(function (item, index) {
      subseq.par(function () {
        fn.call(this, item, index);
      }).limit(limit);
    });
    subseq.seq(function () {
      this(null, self.apply(self, [null].concat(args)));
    }).catch(this);
  });
};

Seq.prototype.seqMap = function (fn) {
  return this.seq(function () {
    var self = this;
    var subseq = Seq();
    var args = Array.prototype.slice.call(arguments);
    var stack = [null];
    args.forEach(function (item, index) {
      subseq.seq(function () {
        var that = this;
        fn.call(function (e, ret) {
          that(e, stack.push(ret));
        }, item, index);
      });
    });
    subseq.seq(function () {
      this(null, self.apply(self, stack));
    }).catch(this);
  });
};

Seq.prototype.parMap = function (limit, fn) {
  fn = maybe(fn).kindOf(Function).getOrElse(limit);
  limit = maybe(limit).kindOf(Number).getOrElse(Infinity);
  return this.seq(function () {
    var self = this;
    var subseq = Seq();
    var args = Array.prototype.slice.call(arguments);
    args.forEach(function (item, index) {
      subseq.par(function () {
        fn.call(this, item, index);
      }).limit(limit);
    });
    subseq.seq(function () {
      this(null, self.apply(self, [null].concat(Array.prototype.slice.call(arguments))));
    }).catch(this);
  });
};

Seq.prototype.flatten = function (fully) {
  return this.seq(function () {
    this.apply(this, [null].concat(_.flatten(arguments, !fully)));
  });
};

Seq.prototype.unflatten = function () {
  return this.seq(function () {
    this.apply(this, [null, Array.prototype.slice.call(arguments)]);
  });
};

Seq.prototype.extend = function (arr) {
  return this.seq(function () {
    this.apply(this, [null].concat(Array.prototype.slice.call(arguments), arr));
  });
};

Seq.prototype.set = function (arr) {
  return this.seq(function () {
    this.apply(this, [null, arr]);
  });
};

Seq.prototype.empty = function () {
  return this.seq(function () {
    this();
  });
};

Seq.prototype.push = function (/*args*/) {
  var args = Array.prototype.slice.call(arguments);
  return this.seq(function () {
    this.apply(this, [null].concat(Array.prototype.slice.call(arguments), args));
  });
};

Seq.prototype.pop = function () {
  return this.seq(function () {
    this.apply(this, [null].concat(Array.prototype.slice.call(arguments, 0, -1)));
  });
};

Seq.prototype.shift = function () {
  return this.seq(function () {
    this.apply(this, [null].concat(Array.prototype.slice.call(arguments, 1)));
  });
};

Seq.prototype.unshift = function (/*args*/) {
  var args = Array.prototype.slice.call(arguments);
  return this.seq(function () {
    this.apply(this, [null].concat(args, Array.prototype.slice.call(arguments)));
  });
};

Seq.prototype.splice = function (index, howMany, toAppend) {
  toAppend = maybe(toAppend).kindOf(Array).getOrElse([toAppend]);
  return this.seq(function () {
    var args = Array.prototype.slice.call(arguments);
    Array.prototype.splice.apply(args, [index, howMany].concat(toAppend));
    this.apply(this, [null].concat(args));
  });
};

Seq.prototype.reverse = function () {
  return this.seq(function () {
    this.apply(this, [null].concat(Array.prototype.slice.call(arguments).reverse()));
  });
};

Seq.prototype.debug = function () {
  var self = this;
  return this.seq(function () {
    this.apply(this, [null].concat(Array.prototype.slice.call(arguments)));
    console.log('̲........................................');
    console.log('->FUN STACK:');
    console.log(util.inspect(self.stack));
    console.log('->ARG STACK:');
    console.log(util.inspect(self.args));
    console.log('........................................');
  });
};
