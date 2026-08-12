<?php
/**
 * Plugin Name: Firestarter AI Schema
 * Description: Renders LocalBusiness/Organization JSON-LD schema pushed from the Firestarter AI Audit tool, and exposes a small REST API so it stays current automatically -- no copy-pasting a <script> snippet by hand.
 * Version: 1.0.1
 * Author: Firestarter
 * Requires at least: 5.6
 *
 * Setup, one time per site:
 *   1. Plugins -> Add New -> Upload Plugin -> choose this .zip -> Install -> Activate.
 *   2. Users -> Profile (as an Administrator) -> Application Passwords -> add
 *      a new one named "Firestarter AI Audit" -> copy the generated password.
 *   3. Paste that password (and the username) into the Schema Generator's
 *      "Connect WordPress" section in the Firestarter AI Audit tool.
 * From then on, clicking "Publish to WordPress" there updates this site's
 * schema with no further manual steps.
 *
 * A note on caching: this plugin's own REST responses are sent with
 * Cache-Control: no-store, so a status check always reflects the real,
 * current value. It CANNOT control a separate page-caching plugin (WP
 * Rocket, WP Super Cache, W3 Total Cache, etc.) or a CDN like Cloudflare
 * that caches the full rendered page -- those have no way of knowing this
 * plugin just changed something, and will keep serving an old cached
 * homepage until purged. If a freshly published schema doesn't show up on
 * the live page, purge that cache and check again before assuming
 * something's wrong.
 */

if (!defined('ABSPATH')) {
    exit; // No direct access.
}

define('FIRESTARTER_SCHEMA_OPTION', 'firestarter_schema_jsonld');
define('FIRESTARTER_SCHEMA_UPDATED_OPTION', 'firestarter_schema_updated_at');

// Render the stored schema on every page. A single LocalBusiness/
// Organization node describing the business is valid -- and recommended --
// sitewide, not just on the homepage, matching the original plan's
// "renders sitewide" requirement for this delivery path.
add_action('wp_head', function () {
    $json = get_option(FIRESTARTER_SCHEMA_OPTION);
    if (!$json) {
        return;
    }
    echo "\n<script type=\"application/ld+json\">\n" . $json . "\n</script>\n";
});

add_action('rest_api_init', function () {
    // Write endpoint -- the Firestarter AI Audit tool pushes updated schema
    // here whenever a strategist clicks "Publish." Requires an
    // authenticated request (WordPress's native Application Passwords,
    // Users -> Profile -> Application Passwords -- no plugin-specific auth
    // system here) from an account that can manage_options.
    register_rest_route('firestarter-schema/v1', '/update', array(
        'methods' => 'POST',
        'callback' => 'firestarter_schema_update',
        'permission_callback' => function () {
            return current_user_can('manage_options');
        },
    ));

    // Read endpoint -- deliberately public. It only ever returns exactly
    // what's already rendered, publicly, in this site's own <head> --
    // there's nothing here that isn't already visible to anyone who views
    // page source. This is what lets the Firestarter tool confirm what's
    // actually live on the site at any time, without needing credentials
    // just to check.
    register_rest_route('firestarter-schema/v1', '/status', array(
        'methods' => 'GET',
        'callback' => 'firestarter_schema_status',
        'permission_callback' => '__return_true',
    ));
});

// no_cache_headers(response) -> the same WP_REST_Response, with headers set
// so nothing between WordPress and the Firestarter AI Audit tool (a CDN
// like Cloudflare, a caching plugin's REST-aware rules, an intermediate
// proxy) ever serves a stale copy of these two endpoints specifically. This
// does NOT touch page-level caching of the rendered HTML itself -- see the
// header comment at the top of this file.
function firestarter_schema_no_cache_headers($response) {
    $response->header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    $response->header('Pragma', 'no-cache');
    return $response;
}

function firestarter_schema_update(WP_REST_Request $request) {
    $body = $request->get_json_params();
    if (!isset($body['jsonLd']) || !is_array($body['jsonLd'])) {
        return new WP_Error('firestarter_schema_invalid_body', 'Expected a JSON body of the form { "jsonLd": { ... } }.', array('status' => 400));
    }

    $encoded = wp_json_encode($body['jsonLd']);
    if ($encoded === false) {
        return new WP_Error('firestarter_schema_invalid_json', 'Could not encode the provided jsonLd.', array('status' => 400));
    }

    update_option(FIRESTARTER_SCHEMA_OPTION, $encoded);
    // gmdate('c') -- full ISO 8601 with an explicit UTC offset (e.g.
    // "2026-08-12T23:08:49+00:00") -- not current_time('mysql', true),
    // which returns a bare "2026-08-12 23:08:49" with no timezone marker.
    // JavaScript's Date constructor treats a marker-less string like that
    // as LOCAL time, not UTC, which silently shows the wrong "last
    // published" time in the tool's UI by however many hours off UTC the
    // strategist's own timezone is.
    update_option(FIRESTARTER_SCHEMA_UPDATED_OPTION, gmdate('c'));

    return firestarter_schema_no_cache_headers(new WP_REST_Response(array(
        'ok' => true,
        'updatedAt' => get_option(FIRESTARTER_SCHEMA_UPDATED_OPTION),
    )));
}

function firestarter_schema_status(WP_REST_Request $request) {
    $json = get_option(FIRESTARTER_SCHEMA_OPTION);
    return firestarter_schema_no_cache_headers(new WP_REST_Response(array(
        'connected' => true,
        'hasSchema' => !empty($json),
        'jsonLd' => $json ? json_decode($json, true) : null,
        'updatedAt' => get_option(FIRESTARTER_SCHEMA_UPDATED_OPTION) ?: null,
    )));
}
