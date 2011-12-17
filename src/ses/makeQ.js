// Copyright (C) 2011 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Implements the EcmaScript
 * http://wiki.ecmascript.org/doku.php?id=strawman:concurrency
 * strawman, securely when run a Caja or SES platform.
 *
 * @author Mark S. Miller, based on earlier designs by Tyler Close,
 * Kris Kowal, and Kevin Reid.
 * //provides makeQ
 * @requires WeakMap, cajaVM, this
 */

(function(global) {
   "use strict";

   var bind = Function.prototype.bind;
   // See
   // http://wiki.ecmascript.org/doku.php?id=conventions:safe_meta_programming
   var uncurryThis = bind.bind(bind.call);

   var bindFn = uncurryThis(bind);
   var applyFn = uncurryThis(bind.apply);
   var sliceFn = uncurryThis([].slice);
   var toStringFn = uncurryThis({}.toString);

   var def;
   if (typeof cajaVM !== 'undefined') {
     def = cajaVM.def;
   } else {
     // Don't bother being properly defensive when run outside of Caja
     // or SES.
     def = Object.freeze;
   }

   /**
    * http://wiki.ecmascript.org/doku.php?id=harmony:egal
    */
   var is = Object.is || def(function(x, y) {
     if (x === y) {
       // 0 === -0, but they are not identical
       return x !== 0 || 1 / x === 1 / y;
     }

     // NaN !== NaN, but they are identical.
     // NaNs are the only non-reflexive value, i.e., if x !== x,
     // then x is a NaN.
     // isNaN is broken: it converts its argument to number, so
     // isNaN("foo") => true
     return x !== x && y !== y;
   });

   /**
    * Tests if the presumably thrown error is simply signaling the end
    * of a generator's iteration.
    *
    * <p>TODO(erights): Find some way to accomodate Firefox's
    * pre-harmony iterators, at least for pre-harmony testing. Take a
    * look at how Kris Kowal's q library handles this.
    *
    * <p>See
    * http://wiki.ecmascript.org/doku.php?id=harmony:iterators#stopiteration
    */
   function isStopIteration(err) {
     return toStringFn(err) === '[object StopIteration]';
   }


   /**
    * Makes a Q object which uses the provided setTimeout function to
    * postpone events to future turns.
    */
   function makeQ(setTimeout) {

     /**
      * Maps from promises to their handlers.
      *
      * <p>All handlers and the "handlers" map must never escape. A
      * handler holds <i>all</i> the state of its promise, serving as a
      * private state record, but more flexible in two ways we take
      * advantage of:
      * <ul>
      * <li>A promise can change state and behavior by changing which
      * handler it is associated with.
      * <li>More than one promise can share the same handler, making them
      * essentially identical except for identity.
      * </ul>
      */
     var handlers = WeakMap();

     /**
      * Among objects, all and only promises have handlers.
      */
     function isPromise(value) {
       if (value !== Object(value)) { return false; }
       return !!handlers.get(value);
     }

     /**
      * Get the "best" handler associated with this promise, shortening
      * "became" chains in the process.
      */
     function handle(promise) {
       var handler = handlers.get(promise);
       if (!handler || !handler.became) { return handler; }
       while (handler.became) {
         handler = handler.became;
       }
       handlers.set(promise, handler);
       return handler;
     }

     /**
      * Run the thunk later in its own turn, but immediately return a
      * promise for what its outcome will be.
      */
     function postpone(thunk) {
       var result = defer();
       setTimeout(function() {
         var value;
         try {
           value = thunk();
         } catch (reason) {
           value = reject(reason);
         }
         result.resolve(value);
       }, 0);
       return result.promise;
     }

     /**
      * To deliver a messenger to a handler is to eventually ask the handler to
      * dispatch on the meesage carried by the messenger, and to return the
      * outcome to the messenger's resolver.
      *
      * <p>A messenger is a record with
      * <ul>
      * <li>OP - the name of one of the concrete handler methods spelled
      * in all upper case, which is currently GET, POST, PUT, DELETE, and
      * WHEN. We might add the other HTTP verbs, HEAD and OPTION. And we
      * might add the other needed reference bookkeeping operation,
      * WHEN_BROKEN, so that a farPromise can notify if it later breaks.
      * <li>args - the array of arguments to use when calling the
      * handler's OP method.
      * <li>resolve - a resolver function, for reporting the outcome of
      * eventually asking the handler to dispatch the messenger's message.
      * </ul>
      * The messenger's message consists of its OP and args.
      *
      * <p>A handler's dispatch method may deliver the messenger's message
      * to this handler, buffer the messenger for later, or ask another
      * handler to dispatch it.
      */
     function deliver(handler, messenger) {
       var value;
       setTimeout(function() {
         try {
           value = handler.dispatch(messenger.OP,
                                    messenger.args);
         } catch (reason) {
           value = reject(reason);
         }
         messenger.resolve(value);
       }, 0);
     }


     /*************************************************************************
      * A near promise's resolution is a non-promise.
      *
      * <p>"promise" must be a near promise whose handler is this
      * handler. "target" must be a non-promise. The NearHandler
      * constructor does not actually use its "promise" argument, but it
      * is there to support the general HandlerConstructor API as assumed
      * by the Promise constructor.
      */
     function NearHandler(promise, target) {
       this.target = target;
     }
     NearHandler.prototype = {

       stateName: 'near',

       nearer: function() { return this.target; },

       dispatch: function(OP, args) {
         return applyFn(this[OP], this, args);
       },

       POST: function(opt_name, args) {
         var target = this.target;
         if (opt_name === null || opt_name === void 0) {
           return applyFn(target, void 0, args);
         } else {
           return applyFn(target[opt_name], target, args);
         }
       },

       GET: function(name)        { return this.target[name]; },
       PUT: function(name, value) { this.target[name] = value; return void 0; },
       DELETE: function(name)     { return delete this.target[name]; },

       /** Just invoke sk, the success continuation */
       WHEN:function(sk, fk)      { return sk(this.target); }
     };

     /**
      * Returns the promise form of value.
      *
      * <p>If value is already a promise, return it. Otherwise wrap it
      * in a promise that is already resolved to value.
      */
     function Q(value) {
       if (isPromise(value)) { return value; }
       return new Promise(NearHandler, value);
     }


     /*************************************************************************
      * A broken promise will never deliver any operations because of the
      * stated reason.
      *
      * <p>"promise" must be a broken promise whose handler is this handler.
      * "reason" will typically be a thrown Error. An originally broken
      * promise's resolution is itself. A broken promise's resolution is
      * a broken promise just like itself, except possibly for identity.
      */
     function BrokenHandler(promise, reason) {
       this.promise = promise;
       this.reason = reason;

       this.stateName = 'broken (by ' + reason + ')';
     }
     BrokenHandler.prototype = {

       nearer: function() { return this.promise; },

       dispatch: function(OP, args) {
         if (OP === 'WHEN')  { return this.WHEN (args[0], args[1]); }
         return this.promise;
       },

       /** Just invoke fk, the failure continuation */
       WHEN:  function(sk, fk)         { return fk(this.reason); }
     };

     /**
      * Reject makes a new broken promise which reports "reason" as the
      * alleged reason why it is broken.
      *
      * <p>Does a def(reason), which (transitively under SES) freezes
      * reason.
      */
     function reject(reason) {
       reason = def(reason);
       try {
         return new Promise(BrokenHandler, reason);
       } catch (err) {
         // Workaround undiagnosed intermittent FF bug. TODO(erights):
         // isolate and report.
         // debugger;
         reason = 'Failing to report error for mysterious reasons';
       }
       return new Promise(BrokenHandler, reason);
     }

     /**
      * Resolving a promise to itself breaks all promises in the loop
      * with the reason being an Error complaining of a vicious promise
      * cycle.
      */
     var theViciousCycle;
     var theViciousCycleHandler;


     /*************************************************************************
      * The handler for a local unresolved promise, as made by defer().
      *
      * <p>"promise" must be a local unresolved promise.
      */
     function UnresolvedHandler(promise, queue) {
       this.promise = promise;
       this.queue = queue;
     }
     UnresolvedHandler.prototype = {

       stateName: 'unresolved',

       nearer: function() { return this.promise; },

       dispatch: function(OP, args) {
         var result = defer();
         this.queue({
           resolve: result.resolve,
           OP: OP,
           args: args
         });
         return result.promise;
       }
     };

     /**
      * Have all promises which were using oldHandler as their handler
      * instead use newPromise's handler as their handler.
      *
      * <p>oldHandler must be a become-able kind of handler, i.e., an
      * UnresolvedHandler, FarHandler, or RemoteHandler. It also must
      * not yet have become anything.
      */
     function become(oldHandler, newPromise) {
       oldHandler.became = theViciousCycleHandler;
       var newHandler = handle(newPromise);
       oldHandler.became = newHandler;
       return newHandler;
     }

     /**
      * Returns an unresolved promise and its corresponding resolver
      * (resolve function).
      */
     function defer() {
       var buffer = [];
       function queue(messenger) {
         buffer.push(messenger);
       }
       var promise = new Promise(UnresolvedHandler, queue);
       var handler = handle(promise);

       function resolve(value) {
         if (!buffer) { return; } // silent
         // assert(handler === handle(promise)) since, the only way this
         // becomes untrue is by a prior call to resolve, which will
         // clear buffer, so we would never get here.

         var buf = buffer;
         buffer = void 0;

         var newHandler = become(handler, Q(value));
         handle(promise); // just to shorten
         handler = void 0; // A dead resolver should not retain dead objects
         promise = void 0;

         var forward;
         if (newHandler instanceof UnresolvedHandler) {
           // A nice optimization but not strictly necessary.
           forward = newHandler.queue;
         } else {
           forward = bindFn(deliver, void 0, newHandler);
         }

         for (var i = 0, len = buf.length; i < len; i++) {
           forward(buf[i]);
         }
       }

       return def({
         promise: promise,
         resolve: resolve
       });
     }


     /*************************************************************************
      * A far promise is a fulfilled promise to a possibly remote
      * object whose behavior is locally represented by a farDispatch
      * function.
      *
      * <p>The farDispatch function acts like the dispatch method of the
      * FarHandler, except that it gets only the HTTP verb operations,
      * not the WHEN operation.
      *
      * <p>To support the reporting of partition, for those farDispatches
      * whose failure model makes partition visible, a far promise may
      * become broken.
      */
     function FarHandler(promise, dispatch) {
       this.promise = promise;
       this.dispatch = dispatch;
     }
     FarHandler.prototype = {
       stateName: 'far',

       nearer: function()       { return this.promise; },

       /** Just invoke sk, the success continuation */
       WHEN:   function(sk, fk) { return sk(this.promise); }
     };

     function makeFar(farDispatch, nextSlotP) {
       var farPromise;

       function dispatch(OP, args) {
         if (OP === 'WHEN') { return farPromise.WHEN(args[0], args[1]); }
         return farDispatch(OP, args);
       }
       farPromise = new Promise(FarHandler, dispatch);


       function breakFar(reason) {
         // Note that a farPromise is resolved, so its nearer()
         // identity must be stable, even when it becomes
         // broken. Thus, we do not become(farHandler, reject(reason))
         // or become(farHandler, nextSlot.value). Rather, we switch
         // to a new broken handler whose promise is this same
         // farPromise.
         var farHandler = handle(farPromise);
         var brokenHandler = new BrokenHandler(farPromise, reason);
         handlers.set(farPromise, brokenHandler);
         become(farHandler, farPromise);
       }

       Q(nextSlotP).get('value').when(function(v) {
         breakFar(new Error('A farPromise can only further resolve to broken'));
       }, breakFar).end();

       return farPromise;
     };


     /*************************************************************************
      * A remote promise is an unresolved promise with a possibly remote
      * resolver, where the behavior of sending a message to a remote
      * promise may be to send the message to that destination (e.g. for
      * promise pipelining). The actual behavior is locally represented
      * by a remoteDispatch function.
      *
      * <p>The remoteDispatch function acts like the dispatch method of the
      * RemoteHandler, except that it gets only the HTTP verb operations,
      * not the WHEN operation. Instead, the WHEN operations are
      * forwarded on to the promise for the remote promise's next
      * resolution.
      */
     function RemoteHandler(promise, dispatch) {
       this.promise = promise;
       this.dispatch = dispatch;
     }
     RemoteHandler.prototype = {
       stateName: 'unresolved remote',

       nearer: function()       { return this.promise; }
     };

     function makeRemote(remoteDispatch, nextSlotP) {
       var remotePromise;

       function dispatch(OP, args) {
         if (OP === 'WHEN') {
           // Send "when"s to the remote promise's eventual next
           // resolution. This has the effect of buffering them locally
           // until there is such a next resolution.
           return Q(nextSlotP).get('value').when(args[0], args[1]);
         }
         return remoteDispatch(OP, args);
       }
       remotePromise = new Promise(RemoteHandler, remoteDispatch);


       Q(nextSlotP).when(function(nextSlot) {
         become(handle(remotePromise, Q(nextSlot.value)));
       }, function(reason) {
         become(handle(remotePromise, reject(reason)));
       }).end();

       return remotePromise;
     };


     /*************************************************************************
      * <p>A promise is an object which represents a reference to some
      * other object, where the other object might be elsewhere (e.g., on
      * a remote machine) or elsewhen (e.g., not yet computed).
      *
      * <p>The Promise constructor must not escape. Clients of this module
      * use the Q function to make promises from non-promises.
      *
      * <p>The various methods on a genuine promise never execute "user
      * code", i.e., possibly untrusted client code, during the immediate
      * call to the promise method, protecting the caller from plan
      * interference hazards. Rather, any such execution happens on later
      * turns scheduled by the promise method. Except for "end", which
      * returns nothing, all other promise methods return genuine
      * promises, enabling safe chaining.
      */
     function Promise(HandlerMaker, arg) {
       var handler = new HandlerMaker(this, arg);
       handlers.set(this, handler);
       def(this);
     }
     Promise.prototype = {
       toString: function() {
         return '[' + handle(this).stateName + ' promise]';
       },
       post: function(opt_name, args) {
         var that = this;
         return postpone(function() {
           return handle(that).dispatch('POST', [opt_name, args]);
         });
       },
       send: function(opt_name, var_args) {
         return applyFn(this.post, this, [opt_name, sliceFn(arguments, 1)]);
       },
       get: function(name) {
         var that = this;
         return postpone(function() {
           return handle(that).dispatch('GET', [name]);
         });
       },
       put: function(name, value) {
         var that = this;
         return postpone(function() {
           return handle(that).dispatch('PUT', [name, value]);
         });
       },
       'delete': function(name) {
         var that = this;
         return postpone(function() {
           return handle(that).dispatch('DELETE', [name]);
         });
       },
       when: function(callback, opt_errback) {
         var errback = opt_errback || function(reason) { throw reason; };
         var done = false;

         /** success continuation */
         function sk(value) {
           if (done) { throw new Error('This "when" already done.'); }
           done = true;
           return postpone(function() { return callback(value); });
         }
         /** failure continuation */
         function fk(reason) {
           if (done) { throw new Error('This "when" already done.'); }
           done = true;
           return postpone(function() { return errback(reason); });
         }

         var that = this;
         return postpone(function() {
           return handle(that).dispatch('WHEN', [sk, fk]);
         });
       },
       end: function() {
         this.when(function(){},
                   function(reason) {
           // So if this setTimeout logs throws that terminate a turn, it
           // will also log this reason.
           setTimeout(function() { throw reason; }, 0);
         });
       }
     };

     function nearer(target1) {
       var optHandler = handle(target1);
       if (!optHandler) { return target1; }
       return optHandler.nearer();
     }

     //////////////////////////////////////////////////////////////////////////

     Q.reject = reject;
     Q.defer = defer;
     Q.isPromise = isPromise;

     Q.makeFar = makeFar;

     Q.makeRemote = makeRemote;

     Q.nearer = nearer;

     theViciousCycle = reject(new Error('vicious promise cycle'));
     theViciousCycleHandler = handle(theViciousCycle);

     //////////////////////////////////////////////////////////////////////////
     // Non-fundamental conveniences below.

     Q.delay = function(millis, opt_answer) {
       var result = Q.defer();
       setTimeout(function() { result.resolve(opt_answer); }, millis);
       return result.promise;
     };

     Q.race = function(var_args) {
       var answerPs = sliceFn(arguments, 0);
       var result = Q.defer();
       answerPs.forEach(function(answerP) {
         Q(answerP).when(function(answer) {
           result.resolve(answer);
         }, function(err) {
           result.resolve(Q.reject(err));
         });
       });
       return result.promise;
     };

     Q.all = function(var_args) {
       var answerPs = sliceFn(arguments, 0);
       var countDown = answerPs.length;
       var answers = [];
       if (countDown === 0) { return Q(answers); }
       var result = Q.defer();
       answerPs.forEach(function(answerP, index) {
         Q(answerP).when(function(answer) {
           answers[index] = answer;
           if (--countDown === 0) {
             // Note: Only a shallow freeze(), not a def().
             result.resolve(Object.freeze(answers));
           }
         }, function(err) {
           result.resolve(Q.reject(err));
         });
       });
       return result.promise;
     };

     Q.join = function(xP, yP) {
       return Q.all(xP, yP).when(function(xy) {
         var x = xy[0];
         var y = xy[1];
         if (is(x, y)) {
           // is() guarantees no observable difference.
           return x;
         } else {
           throw new Error("not the same");
         }
       });
     };

     Q.memoize = function(oneArgFuncP, opt_memoMap) {
       var memoMap = opt_memoMap || WeakMap();

       function oneArgMemo(arg) {
         var resultP = memoMap.get(arg);
         if (!resultP) {
           resultP = Q(oneArgFuncP).send(void 0, arg);
           memoMap.set(arg, resultP);
         }
         return resultP;
       }
       return def(oneArgMemo);
     };

     /**
      * On platforms with generators (either ES-Harmony or existing
      * FF), this can be used with generators to express <a href=
      * "http://wiki.ecmascript.org/doku.php?id=strawman:async_functions"
      * >Asynchronous Functions</a>. Please see that page for further
      * explanation.
      */
     Q.async = function(generatorFunc) {
       return function asyncFunc(var_args) {
         var args = sliceFn(arguments, 0);
         var generator = generatorFunc.apply(this, args);
         var callback = continuer.bind(void 0, 'send');
         var errback = continuer.bind(void 0, 'throw');

         function continuer(verb, valueOrErr) {
           var promisedValue;
           try {
             promisedValue = generator[verb](valueOrErr);
           } catch (err) {
             if (isStopIteration(err)) { return Q(err.value); }
             return Q.reject(err);
           }
           return Q(promisedValue).when(callback, errback);
         }

         return callback(void 0);
       };
     };

     return def(Q);
   };
   def(makeQ);
   global.makeQ = makeQ;
 })(this);
