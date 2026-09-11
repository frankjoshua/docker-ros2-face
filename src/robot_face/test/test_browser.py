"""Optional real-browser regressions; see README for installing Playwright."""
import base64
import os

import pytest

from robot_face.face_node import FaceState

try:
    import playwright.sync_api as playwright
except ImportError:
    playwright = None

# ROS launch-testing imports modules during discovery. A module-level
# importorskip can abort discovery of the whole directory under that plugin.
pytestmark = pytest.mark.skipif(playwright is None, reason='Playwright is not installed')


@pytest.fixture
def page():
    with playwright.sync_playwright() as runtime:
        browser = runtime.chromium.launch(
            executable_path=os.environ.get('CHROMIUM_EXECUTABLE'))
        page = browser.new_page(viewport={'width': 1000, 'height': 600})
        page.set_default_timeout(5000)
        yield page
        browser.close()


def test_diagnostics_display_ros_strings_as_text(page, http_server):
    state = FaceState()
    markup = '<img src=x onerror="window.injected=true">'
    state.diagnostics([{'name': markup, 'level': 2, 'message': markup,
                        'hardware_id': markup, 'values': [[markup, markup]]}])
    page.goto(http_server(state))
    page.locator('#face-layer').click()
    playwright.expect(page.locator('.diag-name')).to_have_text(markup)
    assert page.locator('#diag-list img').count() == 0
    assert not page.evaluate('Boolean(window.injected)')
    assert page.locator('#diag-list').text_content().count(markup) == 5


def test_return_from_map_shows_diagnostics_received_while_hidden(page, http_server):
    state = FaceState()
    page.goto(http_server(state))
    page.locator('#face-layer').click()
    page.locator('#diag-map-btn').click()
    state.diagnostics([{'name': 'battery', 'level': 1, 'message': 'low',
                        'hardware_id': '', 'values': []}])
    # Wait for receipt before navigating, independently of rendering.
    page.wait_for_function('diagnostics.length === 1')
    page.locator('#map-back').click()
    playwright.expect(page.locator('.diag-msg')).to_have_text('low')


@pytest.fixture
def map_page(page, http_server):
    state = FaceState()
    calls = []
    state.map(1, 10, 10, [10, 20], base64.b64encode(bytes(100)).decode())
    page.goto(http_server(state, lambda x, y: calls.append((x, y))))
    page.locator('#face-layer').click()
    page.locator('#diag-map-btn').click()
    playwright.expect(page.locator('#map-empty')).to_be_hidden()
    return page, calls


def test_map_cell_center_publishes_correct_goal(map_page):
    page, calls = map_page
    with page.expect_response('**/goal') as response:
        page.mouse.click(230, 570)
    assert response.value.status == 204
    assert calls == [(10.5, 20.5)]


def test_map_margin_does_not_publish_goal(map_page):
    page, calls = map_page
    page.mouse.click(100, 300)
    with page.expect_response('**/goal'):
        page.mouse.click(500, 300)
    assert calls == [(15, 25)]


def test_map_resize_updates_rendering_and_click_coordinates(map_page):
    page, calls = map_page
    page.set_viewport_size({'width': 600, 'height': 1000})
    page.wait_for_function('document.getElementById("map-canvas").height === 1000')
    with page.expect_response('**/goal'):
        page.mouse.click(300, 500)
    assert calls == [(15, 25)]
