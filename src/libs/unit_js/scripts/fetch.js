(function () {
  "use strict";
  var _fetchSync = __fetch_sync;
  var _triggerPath = globalThis.__triggerBasePath || "";
  var _selfHost = (globalThis.__selfHost || "").toLowerCase();

  function rewriteSelfUrl(url) {
    if (!_triggerPath || _triggerPath === "/" || !_selfHost) return url;
    try {
      var schemeEnd = url.indexOf("://");
      if (schemeEnd === -1) return url;

      var hostStart = schemeEnd + 3;
      var pathStart = url.indexOf("/", hostStart);

      if (pathStart === -1) {
        var qIdx = url.indexOf("?", hostStart);
        var hp = (qIdx === -1 ? url.substring(hostStart) : url.substring(hostStart, qIdx)).toLowerCase();
        if (hp !== _selfHost) return url;
        var q = qIdx === -1 ? "" : url.substring(qIdx);
        return url.substring(0, hostStart) + hp + _triggerPath + q;
      }

      var hostPort = url.substring(hostStart, pathStart).toLowerCase();
      if (hostPort !== _selfHost) return url;

      var rest = url.substring(pathStart);
      if (rest === "/" || (rest.length > 1 && rest.charAt(1) === "?")) {
        var query = rest === "/" ? "" : rest.substring(1);
        return url.substring(0, pathStart) + _triggerPath + query;
      }
    } catch (e) {}
    return url;
  }

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

        url = rewriteSelfUrl(url);

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
