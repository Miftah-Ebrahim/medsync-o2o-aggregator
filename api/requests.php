<?php
/**
 * api/requests.php
 * Core endpoint for the medication_requests workflow.
 *
 * GET    /api/requests.php                     -> list all requests (newest first)
 * GET    /api/requests.php?pharmacy_feed=1      -> list only Pending requests (pharmacy live feed)
 * POST   /api/requests.php                      -> create a new request (Patient: "Snap/Type & Send")
 * PATCH  /api/requests.php?action=claim         -> Pharmacy confirms stock ("Match & Lock" step 1)
 *          body: { request_id, pharmacy_id }
 * PATCH  /api/requests.php?action=pay           -> Patient pays 20 ETB Telebirr fee ("Match & Lock" step 2)
 *          body: { request_id }
 * PATCH  /api/requests.php?action=pickup        -> Patient marks as collected ("Click & Collect")
 *          body: { request_id }
 */

require_once __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $pharmacyFeed = isset($_GET['pharmacy_feed']);
    $userId = $_GET['user_id'] ?? '';
    $pharmacyIdParam = $_GET['pharmacy_id'] ?? '';

    $selectCols = 'id,patient_name,medication_name,status,pharmacy_id,user_id,notes,fee_paid,telebirr_ref,timestamp,updated_at,user_lat,user_lng,pharmacies(pharmacy_name,area,location_lat,location_lng,google_maps_link)';

    if ($pharmacyFeed) {
        // Pharmacies only need to see unclaimed, broadcasted requests
        $path = "medication_requests?select={$selectCols}&status=eq.Pending&order=timestamp.desc";
    } elseif ($userId !== '') {
        // Determine role and pharmacy_id from profiles table
        $profileResult = supabase_request("profiles?id=eq.{$userId}&select=role,pharmacy_id", 'GET');
        $role = 'patient';
        $pharmacyId = null;
        if ($profileResult['status'] === 200 && is_array($profileResult['data']) && count($profileResult['data']) > 0) {
            $role = $profileResult['data'][0]['role'] ?? 'patient';
            $pharmacyId = $profileResult['data'][0]['pharmacy_id'] ?? null;
        }

        if ($role === 'pharmacy_staff') {
            $pId = !empty($pharmacyIdParam) ? $pharmacyIdParam : $pharmacyId;
            if (!empty($pId)) {
                // Lock dashboard to requests claimed by this specific pharmacy_id
                $path = "medication_requests?select={$selectCols}&pharmacy_id=eq.{$pId}&order=timestamp.desc";
            } else {
                // Not assigned to any pharmacy yet -> return empty array
                json_response([], 200);
            }
        } elseif ($role === 'patient') {
            // Lock dashboard to patient's own requests
            $path = "medication_requests?select={$selectCols}&user_id=eq.{$userId}&order=timestamp.desc";
        } else {
            // Admin or other role fallback
            if ($pharmacyIdParam !== '') {
                $path = "medication_requests?select={$selectCols}&pharmacy_id=eq.{$pharmacyIdParam}&order=timestamp.desc";
            } else {
                $path = "medication_requests?select={$selectCols}&order=timestamp.desc";
            }
        }
    } else {
        if ($pharmacyIdParam !== '') {
            $path = "medication_requests?select={$selectCols}&pharmacy_id=eq.{$pharmacyIdParam}&order=timestamp.desc";
        } else {
            $path = "medication_requests?select={$selectCols}&order=timestamp.desc";
        }
    }

    $result = supabase_request($path, 'GET');
    json_response($result['data'], $result['status'] === 200 ? 200 : $result['status']);
}

if ($method === 'POST') {
    $body = read_json_body();

    $patientName = trim($body['patient_name'] ?? '');
    $medicationName = trim($body['medication_name'] ?? '');
    $notes = trim($body['notes'] ?? '');
    $userId = trim($body['user_id'] ?? '');

    if ($patientName === '' || $medicationName === '') {
        json_error('patient_name and medication_name are required.', 422);
    }

    $payload = [
        'patient_name' => $patientName,
        'medication_name' => $medicationName,
        'notes' => $notes !== '' ? $notes : null,
        'status' => 'Pending',
    ];

    // Link to authenticated user if provided
    if ($userId !== '') {
        $payload['user_id'] = $userId;
    }

    // Attach geospatial coordinates if provided
    if (isset($body['user_lat']) && $body['user_lat'] !== '') {
        $payload['user_lat'] = (float)$body['user_lat'];
    }
    if (isset($body['user_lng']) && $body['user_lng'] !== '') {
        $payload['user_lng'] = (float)$body['user_lng'];
    }

    $result = supabase_request('medication_requests', 'POST', $payload, ['Prefer: return=representation']);
    json_response($result['data'], $result['status'] === 201 ? 201 : $result['status']);
}

if ($method === 'PATCH') {
    $action = $_GET['action'] ?? '';
    $body = read_json_body();
    $requestId = $body['request_id'] ?? null;

    if (!$requestId) {
        json_error('request_id is required.', 422);
    }

    if ($action === 'claim') {
        // Pharmacy confirms stock & claims the request.
        // Guard: only claim if the request is still Pending, so two pharmacies
        // can't double-book the same request (simple optimistic lock via filter).
        $pharmacyId = $body['pharmacy_id'] ?? null;
        if (!$pharmacyId) {
            json_error('pharmacy_id is required.', 422);
        }

        $path = "medication_requests?id=eq.{$requestId}&status=eq.Pending";
        $payload = [
            'status' => 'Matched',
            'pharmacy_id' => $pharmacyId,
            'updated_at' => date('c'),
        ];
        $result = supabase_request($path, 'PATCH', $payload, ['Prefer: return=representation']);

        if ($result['status'] === 200 && is_array($result['data']) && count($result['data']) === 0) {
            // No rows matched the Pending filter -> already claimed by someone else
            json_error('This request has already been claimed by another pharmacy.', 409);
        }

        json_response($result['data'], $result['status']);
    }

    if ($action === 'pay') {
        // Patient completes the simulated Telebirr 20 ETB micro-reservation fee.
        $telebirrRef = 'TB-' . strtoupper(bin2hex(random_bytes(4)));

        $path = "medication_requests?id=eq.{$requestId}&status=eq.Matched";
        $payload = [
            'status' => 'Locked',
            'fee_paid' => true,
            'telebirr_ref' => $telebirrRef,
            'updated_at' => date('c'),
        ];
        $result = supabase_request($path, 'PATCH', $payload, ['Prefer: return=representation']);
        json_response($result['data'], $result['status']);
    }

    if ($action === 'pickup') {
        // Patient walks in and completes the offline purchase -> "Click & Collect" done.
        $path = "medication_requests?id=eq.{$requestId}&status=eq.Locked";
        $payload = [
            'status' => 'Picked Up',
            'updated_at' => date('c'),
        ];
        $result = supabase_request($path, 'PATCH', $payload, ['Prefer: return=representation']);
        json_response($result['data'], $result['status']);
    }

    json_error('Unknown action. Use claim, pay, or pickup.', 400);
}

json_error('Method not allowed.', 405);
