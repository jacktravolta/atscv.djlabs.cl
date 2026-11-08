#!/usr/bin/env python3
"""Static server for the ATS CV Match front with correct cache headers.

WHY THIS EXISTS
---------------
The plain `python3 -m http.server` sends NO Cache-Control header, so
Cloudflare keeps the HTML/JS in its edge cache for hours and goes on serving
a STALE front. That was a real production bug: the cached api-config.js
pointed at a dead local origin (http://127.0.0.1:8099), so every browser
called an address that does not exist — the chat never reached the API.

`Cache-Control: no-cache` makes the edge (and the browser) revalidate with
the origin on every request. The origin answers 304 when the file did not
change, so the cost stays low and the front is never stale.

Usage:
    python3 serve_front.py <port> <directory>
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class FrontHandler(SimpleHTTPRequestHandler):
    """Static handler that always asks for revalidation."""

    def end_headers(self) -> None:
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args) -> None:
        # Keep the tunnel log readable: only errors are interesting.
        if args and str(args[1] if len(args) > 1 else '').startswith('4') is False:
            return
        super().log_message(fmt, *args)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8002
    directory = sys.argv[2] if len(sys.argv) > 2 else '.'

    handler = lambda *args, **kwargs: FrontHandler(*args, directory=directory, **kwargs)
    server = ThreadingHTTPServer(('0.0.0.0', port), handler)
    print(f'serving {directory} on 0.0.0.0:{port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
