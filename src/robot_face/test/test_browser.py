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
        context = browser.new_context(viewport={'width': 1000, 'height': 600}, has_touch=True)
        page = context.new_page()
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


def test_diagnostics_tap_preserves_expansion_and_focus_during_updates(page, http_server):
    state = FaceState()
    battery = {'name': 'battery', 'level': 0, 'message': 'Healthy',
               'hardware_id': 'bms', 'values': [['Voltage', '24.1 V']]}
    state.diagnostics([battery, {'name': 'motors', 'level': 0, 'message': 'Ready',
                                'hardware_id': '', 'values': []}])
    page.goto(http_server(state))
    page.locator('#face-layer').click()
    row = page.locator('.diag-row').filter(has=page.locator('.diag-name', has_text='battery'))
    summary = row.locator('summary')
    playwright.expect(row.locator('.diag-hw')).to_be_hidden()
    summary.tap()
    playwright.expect(row.locator('.diag-hw')).to_be_visible()
    playwright.expect(row.locator('dd')).to_have_text('24.1 V')
    summary.focus()

    state.diagnostics([{**battery, 'level': 1, 'message': 'Low voltage',
                        'values': [['Voltage', '21.0 V']]}])
    playwright.expect(row.locator('dd')).to_have_text('21.0 V')
    playwright.expect(row.locator('.diag-level')).to_have_text('Warning')
    playwright.expect(row.locator('.diag-hw')).to_be_visible()
    playwright.expect(summary).to_be_focused()

    page.locator('#diag-map-btn').click()
    page.locator('#map-back').click()
    playwright.expect(row.locator('.diag-hw')).to_be_visible()
    summary.tap()
    playwright.expect(row.locator('.diag-hw')).to_be_hidden()
    state.diagnostics([{**battery, 'message': 'Recovered'}])
    playwright.expect(row.locator('.diag-msg')).to_have_text('Recovered')
    playwright.expect(row.locator('.diag-hw')).to_be_hidden()

    summary.focus()
    summary.press('Enter')
    playwright.expect(row.locator('.diag-hw')).to_be_visible()
    summary.press('Space')
    playwright.expect(row.locator('.diag-hw')).to_be_hidden()


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


def canvas_pixel(page, x, y):
    return page.evaluate('''([x, y]) => Array.from(document.getElementById('map-canvas')
        .getContext('2d').getImageData(x, y, 1, 1).data)''', [x, y])


def test_map_draws_navigation_overlays_and_clears_old_path(page, http_server):
    state = FaceState()
    state.map(1, 10, 10, [10, 20], base64.b64encode(bytes(100)).decode())
    state.pose(12, 22, 0)
    state.goal(18, 28)
    state.path([[12, 22], [12, 28], [18, 28]])
    page.goto(http_server(state))
    page.locator('#face-layer').click()
    page.locator('#diag-map-btn').click()
    page.wait_for_function('plannedPath.length === 3 && goalPosition !== null && robotPose !== null')
    assert canvas_pixel(page, 320, 480) == [255, 0, 255, 255]  # robot
    assert canvas_pixel(page, 680, 120) == [255, 204, 51, 255]  # goal crosshair
    assert canvas_pixel(page, 320, 300) == [51, 255, 102, 255]  # path

    # Replay after reconnect and redraw after resizing preserve all overlays.
    page.reload()
    page.locator('#face-layer').click()
    page.locator('#diag-map-btn').click()
    page.set_viewport_size({'width': 600, 'height': 1000})
    page.wait_for_function('mapCanvas.height === 1000 && plannedPath.length === 3')
    assert canvas_pixel(page, 120, 680) == [255, 0, 255, 255]
    assert canvas_pixel(page, 480, 320) == [255, 204, 51, 255]
    assert canvas_pixel(page, 120, 500) == [51, 255, 102, 255]

    state.path([])
    page.wait_for_function('plannedPath.length === 0')
    assert canvas_pixel(page, 120, 500) == [10, 10, 10, 255]


def test_map_tap_draws_goal_in_all_browsers(page, http_server):
    state = FaceState()
    state.map(1, 10, 10, [10, 20], base64.b64encode(bytes(100)).decode())
    url = http_server(state)
    other = page.context.new_page()
    for browser_page in (page, other):
        browser_page.goto(url)
        browser_page.locator('#face-layer').click()
        browser_page.locator('#diag-map-btn').click()
    with page.expect_response('**/goal'):
        page.mouse.click(500, 300)
    for browser_page in (page, other):
        browser_page.wait_for_function('goalPosition !== null')
        assert canvas_pixel(browser_page, 500, 300) == [255, 204, 51, 255]
    other.close()
