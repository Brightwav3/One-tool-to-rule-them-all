import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "converter"))

import server  # noqa: E402


class BackendApiTests(unittest.TestCase):
    def setUp(self):
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.staging = tempfile.TemporaryDirectory()
        self.httpd.staging_dir = Path(self.staging.name)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.staging.cleanup()

    def get_json(self, route):
        with urlopen(self.base_url + route) as response:
            return json.loads(response.read().decode("utf-8"))

    def test_json_api_is_available(self):
        tools = self.get_json("/api/tools")
        state = self.get_json("/api/state")
        self.assertIn("tools", tools)
        self.assertIn("files", state)

    def test_root_serves_the_electron_renderer(self):
        """The shell loads, and the draggable title bar is actually served.

        The drag region used to be inline in index.html and was asserted there.
        The UI decomposition moved it to styles/shell.css, which broke this test
        without breaking the app. Assert the behaviour over HTTP wherever it
        lives rather than pinning the test to one file's contents: the shell
        must link the stylesheet, and the server must serve it with the region
        intact.
        """
        with urlopen(self.base_url + "/") as response:
            body = response.read().decode("utf-8")
        self.assertEqual(response.status, 200)
        self.assertIn("One Tool", body)
        self.assertIn("/styles/shell.css", body)

        with urlopen(self.base_url + "/styles/shell.css") as response:
            shell_css = response.read().decode("utf-8")
        self.assertEqual(response.status, 200)
        self.assertIn("-webkit-app-region:drag", shell_css)

    def test_api_routes_are_literal_root_paths(self):
        for route in ("/api/tools/", "/v1/api/tools", "/converter/api/tools"):
            with self.subTest(route=route):
                with self.assertRaises(HTTPError) as context:
                    urlopen(self.base_url + route)
                self.assertEqual(context.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
