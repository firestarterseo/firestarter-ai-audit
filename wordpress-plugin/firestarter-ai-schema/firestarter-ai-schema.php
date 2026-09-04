<?php
/**
 * Plugin Name: Firestarter AI Schema
 * Description: Renders LocalBusiness/Organization JSON-LD schema pushed from the Firestarter AI Audit tool, and exposes a small REST API so it stays current automatically -- no copy-pasting a <script> snippet by hand. Also supports per-page schema (Phase 7, 2026-09-04) for page-specific structured data (e.g. AboutPage, ContactPage) deployed and verified straight from the tool.
 * Version: 1.1.0
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
 * schema with no further manual steps -- and, once a page's schema work is
 * AM-approved in the tool, clicking "Deploy to WordPress" on that page does
 * the same for that one page's own schema.
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
 *
 * OWNERSHIP MODEL (Phase 7): this plugin only ever renders schema IT was
 * given -- the sitewide block below, and now a per-page block below that.
 * It never reads, rewrites, or removes any other schema already on a page
 * (Yoast, RankMath, a theme, another plugin) -- both blocks are their own
 * separate <script> tags, clearly identified by element id, so what this
 * plugin owns and can safely update/remove later is always unambiguous.
 */

if (!defined('ABSPATH')) {
    exit; // No direct access.
}

define('FIRESTARTER_SCHEMA_OPTION', 'firestarter_schema_jsonld');
define('FIRESTARTER_SCHEMA_UPDATED_OPTION', 'firestarter_schema_updated_at');
define('FIRESTARTER_SCHEMA_PAGE_META', '_firestarter_schema_jsonld');
define('FIRESTARTER_SCHEMA_PAGE_UPDATED_META', '_firestarter_schema_updated_at');

// Render the stored schema on every page. A single LocalBusiness/
// Organization node describing the business is valid -- and recommended --
// sitewide, not just on the homepage, matching the original plan's
// "renders sitewide" requirement for this delivery path.
add_action('wp_head', function () {
    $json = get_option(FIRESTARTER_SCHEMA_OPTION);
    if ($json) {
        echo "\n<script type=\"application/ld+json\" id=\"firestarter-schema-sitewide\">\n" . $json . "\n</script>\n";
    }

    // Per-page schema (Phase 7) -- a SEPARATE, independently-managed block
    // from the sitewide one above, rendered only on the one page it was
    // deployed to. is_singular() covers both WordPress Pages and Posts,
    // matching whatever get_queried_object_id()/url_to_postid() resolved
    // to when this was deployed.
    if (is_singular()) {
        $page_json = get_post_meta(get_queried_object_id(), FIRESTARTER_SCHEMA_PAGE_META, true);
        if ($page_json) {
            echo "\n<script type=\"application/ld+json\" id=\"firestarter-schema-page\">\n" . $page_json . "\n</script>\n";
        }
    }
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

    // Per-page endpoints (Phase 7) -- registered as one route with both
    // methods (WordPress's own documented pattern for a route that
    // supports more than one HTTP method) rather than two separate calls,
    // so there is exactly one place this route's shape is defined.
    //
    // POST body: { "url": "https://.../about/", "jsonLd": {...} }. `url` is
    // resolved to a WordPress post/page id via WordPress's OWN routing
    // (url_to_postid()) -- this plugin never guesses a slug-to-id mapping
    // itself, so it stays correct for any permalink structure the site
    // actually uses. Same auth as /update.
    //
    // GET ?url=https://.../about/ -- public, same "only echoes what's
    // already publicly rendered" reasoning as /status above.
    register_rest_route('firestarter-schema/v1', '/page', array(
        array(
            'methods' => 'POST',
            'callback' => 'firestarter_schema_page_update',
            'permission_callback' => function () {
                return current_user_can('manage_options');
            },
        ),
        array(
            'methods' => 'GET',
            'callback' => 'firestarter_schema_page_status',
            'permission_callback' => '__return_true',
        ),
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

// firestarter_resolve_page_id($url) -> int post id, or 0 if `url` doesn't
// resolve to any post/page on THIS site. Thin wrapper around WordPress's
// own url_to_postid() -- deliberately the ONLY page-resolution mechanism
// here (Phase 7 instruction: "Do not guess page IDs"). url_to_postid()
// matches the URL against this site's actual registered rewrite rules (or
// its plain ?p=/?page_id= query-string form when pretty permalinks are
// off), so it stays correct regardless of this site's permalink structure
// -- something a hand-rolled slug lookup could not guarantee.
function firestarter_resolve_page_id($url) {
    if (!is_string($url) || $url === '') {
        return 0;
    }
    return url_to_postid($url);
}

// firestarter_schema_page_update(request) -- Phase 7 per-page write. Body:
// { "url": "https://.../about/", "jsonLd": {...} }. Stores the EXACT
// jsonLd it was given as this one post's own postmeta -- it never merges,
// rewrites, or re-derives anything from the page's existing markup. The
// Firestarter AI Audit tool is responsible for having already produced
// final, deployable JSON-LD (never the tool's internal add/modify/keep
// control structure) before calling this.
function firestarter_schema_page_update(WP_REST_Request $request) {
    $body = $request->get_json_params();
    if (!isset($body['url']) || !is_string($body['url']) || $body['url'] === '') {
        return new WP_Error('firestarter_schema_invalid_body', 'Expected a JSON body of the form { "url": "https://...", "jsonLd": { ... } }.', array('status' => 400));
    }
    if (!isset($body['jsonLd']) || !is_array($body['jsonLd'])) {
        return new WP_Error('firestarter_schema_invalid_body', 'Expected a JSON body of the form { "url": "https://...", "jsonLd": { ... } }.', array('status' => 400));
    }

    $post_id = firestarter_resolve_page_id($body['url']);
    if (!$post_id) {
        // A specific, distinct error code -- the calling tool relies on
        // THIS exact code (not just a bare 404, which could also mean "the
        // route itself doesn't exist," e.g. the plugin isn't installed) to
        // tell "this page's URL could not be resolved to a WordPress
        // post/page" apart from every other failure mode.
        return new WP_Error('firestarter_schema_page_not_found', 'This URL could not be resolved to a WordPress post or page on this site.', array('status' => 404));
    }

    $encoded = wp_json_encode($body['jsonLd']);
    if ($encoded === false) {
        return new WP_Error('firestarter_schema_invalid_json', 'Could not encode the provided jsonLd.', array('status' => 400));
    }

    update_post_meta($post_id, FIRESTARTER_SCHEMA_PAGE_META, $encoded);
    update_post_meta($post_id, FIRESTARTER_SCHEMA_PAGE_UPDATED_META, gmdate('c'));

    return firestarter_schema_no_cache_headers(new WP_REST_Response(array(
        'ok' => true,
        'postId' => $post_id,
        'updatedAt' => get_post_meta($post_id, FIRESTARTER_SCHEMA_PAGE_UPDATED_META, true),
    )));
}

// firestarter_schema_page_status(request) -- Phase 7 per-page read. Public,
// same reasoning as firestarter_schema_status(): only ever echoes what's
// already rendered, publicly, on that one page. Returns postId: null (not
// an error) when the URL doesn't resolve -- a read is not a write, so an
// unresolved page is simply "nothing to report," not a hard failure.
function firestarter_schema_page_status(WP_REST_Request $request) {
    $url = $request->get_param('url');
    $post_id = firestarter_resolve_page_id($url);
    if (!$post_id) {
        return firestarter_schema_no_cache_headers(new WP_REST_Response(array(
            'connected' => true,
            'postId' => null,
            'hasSchema' => false,
            'jsonLd' => null,
            'updatedAt' => null,
        )));
    }
    $json = get_post_meta($post_id, FIRESTARTER_SCHEMA_PAGE_META, true);
    return firestarter_schema_no_cache_headers(new WP_REST_Response(array(
        'connected' => true,
        'postId' => $post_id,
        'hasSchema' => !empty($json),
        'jsonLd' => $json ? json_decode($json, true) : null,
        'updatedAt' => get_post_meta($post_id, FIRESTARTER_SCHEMA_PAGE_UPDATED_META, true) ?: null,
    )));
}
