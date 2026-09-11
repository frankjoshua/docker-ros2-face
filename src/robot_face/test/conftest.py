import threading
from http.server import ThreadingHTTPServer

import pytest

from robot_face.face_node import make_handler


@pytest.fixture
def http_server():
    servers = []

    def start(state, publish_goal=lambda x, y: None):
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(state, publish_goal))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append((server, thread))
        return f'http://127.0.0.1:{server.server_port}'

    yield start
    for server, thread in servers:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
