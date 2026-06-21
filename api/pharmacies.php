<?php
/**
 * api/pharmacies.php
 * GET /api/pharmacies.php -> list pharmacies (active only, or isolated to staff's pharmacy)
 * PATCH /api/pharmacies.php?action=toggle_status -> toggle is_active status of a pharmacy
 */

require_once __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $userId = $_GET['user_id'] ?? '';

    if ($userId !== '') {
        // Fetch user's profile to check if they are pharmacy_staff/admin and get their pharmacy_id
        $profileResult = supabase_request("profiles?id=eq.{$userId}&select=role,pharmacy_id", 'GET');
        if ($profileResult['status'] === 200 && is_array($profileResult['data']) && count($profileResult['data']) > 0) {
            $profile = $profileResult['data'][0];
            $role = $profile['role'] ?? '';
            if ($role === 'pharmacy_staff' && !empty($profile['pharmacy_id'])) {
                $pharmacyId = $profile['pharmacy_id'];
                // Fetch the staff's specific pharmacy (regardless of active status, so they can reactivate it)
                $result = supabase_request("pharmacies?id=eq.{$pharmacyId}&select=*", 'GET');
                json_response($result['data'], $result['status'] === 200 ? 200 : $result['status']);
            } elseif ($role === 'admin') {
                // Fetch all pharmacies (regardless of active status) for admin
                $result = supabase_request("pharmacies?select=*&order=id.asc", 'GET');
                json_response($result['data'], $result['status'] === 200 ? 200 : $result['status']);
            }
        }
    }

    // Default: list only active pharmacies for public / patient views
    $result = supabase_request('pharmacies?is_active=eq.true&select=*&order=id.asc', 'GET');
    json_response($result['data'], $result['status'] === 200 ? 200 : $result['status']);
}

if ($method === 'PATCH') {
    $action = $_GET['action'] ?? '';
    if ($action === 'toggle_status') {
        $body = read_json_body();
        $pharmacyId = $body['pharmacy_id'] ?? null;
        $isActive = $body['is_active'] ?? null;

        if (!$pharmacyId || $isActive === null) {
            json_error('pharmacy_id and is_active are required.', 422);
        }

        $path = "pharmacies?id=eq.{$pharmacyId}";
        $payload = [
            'is_active' => (bool)$isActive
        ];
        $result = supabase_request($path, 'PATCH', $payload, ['Prefer: return=representation']);
        json_response($result['data'], $result['status']);
    }
    json_error('Unknown action.', 400);
}

json_error('Method not allowed.', 405);
