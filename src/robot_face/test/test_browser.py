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

KIOSK = '/?controls=off'   # no on-screen panel: tapping the face opens diagnostics directly


@pytest.fixture
def page():
    with playwright.sync_playwright() as runtime:
        browser = runtime.chromium.launch(
            executable_path=os.environ.get('CHROMIUM_EXECUTABLE'),
            args=['--enable-unsafe-swiftshader', '--use-angle=swiftshader'])
        context = browser.new_context(viewport={'width': 1000, 'height': 600}, has_touch=True)
        page = context.new_page()
        page.set_default_timeout(10000)
        yield page
        browser.close()


def open_page(page, url):
    page.goto(url)
    page.wait_for_function('window.face && window.face.look')


def open_diagnostics(page):
    page.locator('#stage').click()
    playwright.expect(page.locator('#diag-layer')).to_be_visible()


def open_map(page):
    open_diagnostics(page)
    page.locator('#diag-map-btn').click()
    playwright.expect(page.locator('#map-layer')).to_be_visible()


def test_diagnostics_display_ros_strings_as_text(page, http_server):
    state = FaceState()
    markup = '<img src=x onerror="window.injected=true">'
    state.diagnostics([{'name': markup, 'level': 2, 'message': markup,
                        'hardware_id': markup, 'values': [[markup, markup]]}])
    open_page(page, http_server(state) + KIOSK)
    open_diagnostics(page)
    playwright.expect(page.locator('.diag-name')).to_have_text(markup)
    assert page.locator('#diag-list img').count() == 0
    assert not page.evaluate('Boolean(window.injected)')
    assert page.locator('#diag-list').text_content().count(markup) == 5


def open_menu(page, x=500, y=200):
    page.mouse.click(x, y)
    playwright.expect(page.locator('#controls')).to_have_css('opacity', '1')


def test_face_is_default_and_a_click_opens_the_menu_to_other_screens(page, http_server):
    state = FaceState()
    open_page(page, http_server(state))
    page.mouse.move(500, 200)
    page.wait_for_timeout(500)
    playwright.expect(page.locator('#controls')).to_have_css('opacity', '0')   # moving alone keeps the face clear

    open_menu(page)
    page.mouse.click(500, 200)                                                  # clicking the face again closes it
    playwright.expect(page.locator('#controls')).to_have_css('opacity', '0')

    open_menu(page)
    page.locator('#controls button[data-view="diagnostics"]').click()
    playwright.expect(page.locator('#diag-layer')).to_be_visible()
    playwright.expect(page.locator('#controls')).to_be_hidden()
    page.locator('#diag-back').click()
    playwright.expect(page.locator('#diag-layer')).to_be_hidden()
    playwright.expect(page.locator('#controls')).to_have_css('opacity', '0')   # back on the face, menu closed

    open_menu(page, 520, 220)
    page.locator('#controls button[data-view="map"]').click()
    playwright.expect(page.locator('#map-layer')).to_be_visible()
    playwright.expect(page.locator('#map-empty')).to_be_visible()
    page.locator('#map-face').click()
    playwright.expect(page.locator('#map-layer')).to_be_hidden()

    page.keyboard.press('m')
    playwright.expect(page.locator('#map-layer')).to_be_visible()
    page.keyboard.press('Escape')
    playwright.expect(page.locator('#diag-layer')).to_be_visible()


def test_return_from_map_shows_diagnostics_received_while_hidden(page, http_server):
    state = FaceState()
    open_page(page, http_server(state) + KIOSK)
    open_map(page)
    state.diagnostics([{'name': 'battery', 'level': 1, 'message': 'low',
                        'hardware_id': '', 'values': []}])
    # Wait for receipt before navigating, independently of rendering.
    page.wait_for_function('face.views.state.diagnostics.length === 1')
    page.locator('#map-back').click()
    playwright.expect(page.locator('.diag-msg')).to_have_text('low')


def test_diagnostics_tap_preserves_expansion_and_focus_during_updates(page, http_server):
    state = FaceState()
    battery = {'name': 'battery', 'level': 0, 'message': 'Healthy',
               'hardware_id': 'bms', 'values': [['Voltage', '24.1 V']]}
    state.diagnostics([battery, {'name': 'motors', 'level': 0, 'message': 'Ready',
                                'hardware_id': '', 'values': []}])
    open_page(page, http_server(state) + KIOSK)
    open_diagnostics(page)
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
    open_page(page, http_server(state, lambda x, y: calls.append((x, y))) + KIOSK)
    open_map(page)
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


def theme_rgba(page, key):
    """The active theme's colour for a map element, as canvas RGBA."""
    return page.evaluate('''(key) => {
        const v = face.views.state.theme[key];
        if (Array.isArray(v)) return [...v, 255];
        const n = parseInt(v.replace('#', ''), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
    }''', key)


def test_map_draws_navigation_overlays_and_clears_old_path(page, http_server):
    state = FaceState()
    state.map(1, 10, 10, [10, 20], base64.b64encode(bytes(100)).decode())
    state.pose(12, 22, 0)
    state.goal(18, 28)
    state.path([[12, 22], [12, 28], [18, 28]])
    open_page(page, http_server(state) + KIOSK)
    open_map(page)
    page.wait_for_function('''face.views.state.plannedPath.length === 3
        && face.views.state.goalPosition !== null && face.views.state.robotPose !== null''')
    assert canvas_pixel(page, 320, 480) == theme_rgba(page, 'robot')
    assert canvas_pixel(page, 680, 120) == theme_rgba(page, 'goal')
    assert canvas_pixel(page, 320, 300) == theme_rgba(page, 'path')

    # Replay after reconnect and redraw after resizing preserve all overlays.
    page.reload()
    page.wait_for_function('window.face && window.face.look')
    open_map(page)
    page.set_viewport_size({'width': 600, 'height': 1000})
    page.wait_for_function('''document.getElementById("map-canvas").height === 1000
        && face.views.state.plannedPath.length === 3''')
    assert canvas_pixel(page, 120, 680) == theme_rgba(page, 'robot')
    assert canvas_pixel(page, 480, 320) == theme_rgba(page, 'goal')
    assert canvas_pixel(page, 120, 500) == theme_rgba(page, 'path')

    state.path([])
    page.wait_for_function('face.views.state.plannedPath.length === 0')
    assert canvas_pixel(page, 120, 500) == theme_rgba(page, 'free')


def test_map_and_diagnostics_follow_the_selected_look(page, http_server):
    state = FaceState()
    state.map(1, 10, 10, [10, 20], base64.b64encode(bytes(100)).decode())
    state.pose(12, 22, 0)
    state.diagnostics([{'name': 'battery', 'level': 0, 'message': 'Healthy', 'hardware_id': '', 'values': []}])
    open_page(page, http_server(state) + KIOSK + '&look=murmuration')
    open_map(page)
    page.wait_for_function('face.views.state.robotPose !== null')
    before = {k: theme_rgba(page, k) for k in ('robot', 'free')}
    assert canvas_pixel(page, 320, 480) == before['robot']

    state.look('liquid_glass')   # switched from ROS while the map is open
    page.wait_for_function('document.documentElement.dataset.look === "liquid_glass"')
    after = {k: theme_rgba(page, k) for k in ('robot', 'free')}
    assert after != before
    assert canvas_pixel(page, 320, 480) == after['robot']
    assert canvas_pixel(page, 500, 100) == after['free']   # cells are recoloured, not just overlays

    page.locator('#map-back').click()
    row_bg = page.locator('.diag-row').evaluate('e => getComputedStyle(e).backgroundColor')
    state.look('hologram')
    page.wait_for_function('document.documentElement.dataset.look === "hologram"')
    assert page.locator('.diag-row').evaluate('e => getComputedStyle(e).backgroundColor') != row_bg
    assert 'monospace' in page.locator('#diag-layer').evaluate('e => getComputedStyle(e).fontFamily')


def test_map_tap_draws_goal_in_all_browsers(page, http_server):
    state = FaceState()
    state.map(1, 10, 10, [10, 20], base64.b64encode(bytes(100)).decode())
    url = http_server(state) + KIOSK
    other = page.context.new_page()
    for browser_page in (page, other):
        open_page(browser_page, url)
        open_map(browser_page)
    with page.expect_response('**/goal'):
        page.mouse.click(500, 300)
    for browser_page in (page, other):
        browser_page.wait_for_function('face.views.state.goalPosition !== null')
        assert canvas_pixel(browser_page, 500, 300) == theme_rgba(browser_page, 'goal')
    other.close()
