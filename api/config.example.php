<?php
/**
 * api/config.php
 * Shared bootstrap for all MedSync API endpoints.
 */

// ---- CORS (same-origin SPA, but kept permissive for local dev / grading demo) ----
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ---- Environment variables ----
define('SUPABASE_URL', '');
define('SUPABASE_SERVICE_KEY', '');
define('SUPABASE_ANON_KEY', '');
define('GROQ_API_KEY', '');

/**
 * Send a JSON response and stop execution.
 */
function json_response($data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data);
    exit;
}

/**
 * Send a JSON error response and stop execution.
 */
function json_error(string $message, int $status = 400): void {
    json_response(['error' => $message], $status);
}

/**
 * Perform a request against the Supabase REST API (PostgREST).
 *
 * @param string $path    e.g. "medication_requests?select=*&order=timestamp.desc"
 * @param string $method  GET | POST | PATCH | DELETE
 * @param array|null $body  Associative array to send as JSON body
 * @param array $extraHeaders  Additional headers, e.g. ['Prefer: return=representation']
 * @return array  ['status' => int, 'data' => mixed]
 */
function supabase_request(string $path, string $method = 'GET', ?array $body = null, array $extraHeaders = []): array {
    if (SUPABASE_URL === '' || SUPABASE_SERVICE_KEY === '') {
        return ['status' => 500, 'data' => ['error' => 'Supabase environment variables are not configured on the server.']];
    }

    $url = rtrim(SUPABASE_URL, '/') . '/rest/v1/' . ltrim($path, '/');

    $headers = array_merge([
        'apikey: ' . SUPABASE_SERVICE_KEY,
        'Authorization: Bearer ' . SUPABASE_SERVICE_KEY,
        'Content-Type: application/json',
    ], $extraHeaders);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 15,
    ]);

    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($response === false) {
        return ['status' => 500, 'data' => ['error' => 'Supabase request failed: ' . $curlErr]];
    }

    $decoded = json_decode($response, true);
    return ['status' => $httpCode, 'data' => $decoded];
}

/**
 * Read and decode the JSON body of the current request.
 */
function read_json_body(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}