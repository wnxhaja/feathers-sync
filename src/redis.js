var redis = require('redis');
var debug = require('debug')('feathers-sync:redis');

if (typeof JSON.decycle !== "function") {
    JSON.decycle = function decycle(object, replacer) {
        "use strict";

// Make a deep copy of an object or array, assuring that there is at most
// one instance of each object or array in the resulting structure. The
// duplicate references (which might be forming cycles) are replaced with
// an object of the form

//      {"$ref": PATH}

// where the PATH is a JSONPath string that locates the first occurance.

// So,

//      var a = [];
//      a[0] = a;
//      return JSON.stringify(JSON.decycle(a));

// produces the string '[{"$ref":"$"}]'.

// If a replacer function is provided, then it will be called for each value.
// A replacer function receives a value and returns a replacement value.

// JSONPath is used to locate the unique object. $ indicates the top level of
// the object or array. [NUMBER] or [STRING] indicates a child element or
// property.

        var objects = new WeakMap();     // object to path mappings

        return (function derez(value, path) {

// The derez function recurses through the object, producing the deep copy.

            var old_path;   // The path of an earlier occurance of value
            var nu;         // The new object or array

// If a replacer function was provided, then call it to get a replacement value.

            if (replacer !== undefined) {
                value = replacer(value);
            }

// typeof null === "object", so go on if this value is really an object but not
// one of the weird builtin objects.

            if (
                typeof value === "object" && value !== null &&
                !(value instanceof Boolean) &&
                !(value instanceof Date) &&
                !(value instanceof Number) &&
                !(value instanceof RegExp) &&
                !(value instanceof String)
            ) {

// If the value is an object or array, look to see if we have already
// encountered it. If so, return a {"$ref":PATH} object. This uses an
// ES6 WeakMap.

                old_path = objects.get(value);
                if (old_path !== undefined) {
                    return {$ref: old_path};
                }

// Otherwise, accumulate the unique value and its path.

                objects.set(value, path);

// If it is an array, replicate the array.

                if (Array.isArray(value)) {
                    nu = [];
                    value.forEach(function (element, i) {
                        nu[i] = derez(element, path + "[" + i + "]");
                    });
                } else {

// If it is an object, replicate the object.

                    nu = {};
                    Object.keys(value).forEach(function (name) {
                        nu[name] = derez(
                            value[name],
                            path + "[" + JSON.stringify(name) + "]"
                        );
                    });
                }
                return nu;
            }
            return value;
        }(object, "$"));
    };
}

module.exports = function (config) {
  debug('setting up database %s', config.db);

  return function () {
    var oldSetup = this.setup;

    this.setup = function () {
      var result = oldSetup.apply(this, arguments);
      var services = this.services;
      Object.keys(services).forEach(function (path) {
        var service = services[path];
        service.pub = redis.createClient(config.db);
        service.sub = redis.createClient(config.db);
        service._serviceEvents.forEach(function (event) {
          var ev = path + ' ' + event;
          debug('subscribing to handler %s', ev);
          service.sub.subscribe(ev);
          service.sub.on('message', function (e, data) {
            if (e !== ev) {
              return;
            }

            data = JSON.parse(data);
            debug('got event "%s", calling old emit %s', e, data);
            service._emit.call(service, event, data); // eslint-disable-line no-useless-call
          });
        });
      });
      return result;
    };

    function configurePlugin(service, path) {
      if (typeof service.emit !== 'function' || typeof service.on !== 'function') {
        return;
      }
      // Store the old emit method
      service._emit = service.emit;

      // Override an emit that publishes to the hub
      service.mixin({
        emit: function (ev, data) {
          var event = path + ' ' + ev;
          debug('emitting event to channel %s', event);
          // Something is converting the second argument to a string here
          // So for now, pass the data as a string, and serialize back on other side
          return service.pub.publish(event, JSON.stringify(data));
        }
      });

      if (typeof config.connect === 'function') {
        setTimeout(config.connect, 50);
      }
    }

    if (this.version && parseInt(this.version, 10) >= 3) {
      this.mixins.push(configurePlugin);
    }
    else {
      this.providers.push((path, service) => configurePlugin(service, path));
    }
  };
};
