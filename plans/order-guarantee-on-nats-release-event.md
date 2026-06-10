On case of Redis outage, when a new nats release event is received, we must nack that event, so it will be re-consumed again

Also when it fails (nack), user might have new release rolled out, so the events must be guaranteed to be processed by order