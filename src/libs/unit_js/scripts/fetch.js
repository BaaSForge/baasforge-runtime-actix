(function () {
  "use strict";
  var _fetchSync = __fetch_sync;

  globalThis.fetch = function (input, init) {
    return new Promise(function (resolve, reject) {
      try {
        var url, method, headers, body;

        if (input instanceof Request) {
          url = input.url;
          method = input.method;
          headers = {};
          input.headers.forEach(function (val, key) { headers[key] = val; });
          body = input._body || "";
          if (init) {
            if (init.method) method = init.method.toUpperCase();
            if (init.headers) {
              var h = new Headers(init.headers);
              h.forEach(function (val, key) { headers[key] = val; });
            }
            if (init.body !== undefined) body = init.body;
          }
        } else {
          url = String(input);
          method = (init && init.method) ? init.method.toUpperCase() : "GET";
          headers = {};
          if (init && init.headers) {
            var h = new Headers(init.headers);
            h.forEach(function (val, key) { headers[key] = val; });
          }
          body = (init && init.body !== undefined) ? init.body : "";
        }

        var signal = init && init.signal;
        if (signal && signal.aborted) {
          throw signal.reason || new DOMException("The operation was aborted.", "AbortError");
        }

        var headersJson = JSON.stringify(Object.entries(headers));
        var result = _fetchSync(url, method, headersJson, body || "");

        var respHeaders = new Headers();
        for (var i = 0; i < result.headers.length; i++) {
          respHeaders.append(result.headers[i][0], result.headers[i][1]);
        }

        var bodyBuf = result.body;
        var response = new Response(bodyBuf, {
          status: result.status,
          headers: respHeaders,
        });

        resolve(response);
      } catch (e) {
        reject(e);
      }
    });
  };
})();
