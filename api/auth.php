<?php
/**
 * api/auth.php
 * Authentication support endpoints for MedSync.
 *
 * GET  /api/auth.php?action=profile&user_id=UUID   -> fetch user profile
 * GET  /api/auth.php?action=stats                   -> admin KPI aggregates
 */

require_once __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_error('Method not allowed.', 405);
}

$action = $_GET['action'] ?? '';

// ---- Profile lookup ----
if ($action === 'profile') {
    $userId = $_GET['user_id'] ?? '';
    if ($userId === '') {
        json_error('user_id is required.', 422);
    }

    $path = "profiles?id=eq.{$userId}&select=id,email,full_name,role,pharmacy_id,created_at";
    $result = supabase_request($path, 'GET');

    if ($result['status'] === 200 && is_array($result['data']) && count($result['data']) > 0) {
        json_response($result['data'][0]);
    } else {
        json_error('Profile not found.', 404);
    }
}

// ---- Admin stats (aggregate KPIs) ----
if ($action === 'stats') {
    // Total active requests (non-picked-up)
    $activeResult = supabase_request('medication_requests?select=id&status=neq.Picked%20Up', 'GET');
    $totalActive = is_array($activeResult['data']) ? count($activeResult['data']) : 0;

    // Total requests overall
    $allResult = supabase_request('medication_requests?select=id', 'GET');
    $totalRequests = is_array($allResult['data']) ? count($allResult['data']) : 0;

    // Registered pharmacies
    $pharmResult = supabase_request('pharmacies?select=id', 'GET');
    $totalPharmacies = is_array($pharmResult['data']) ? count($pharmResult['data']) : 0;

    // Total locked/picked-up (completed transactions) — each = 20 ETB
    $paidResult = supabase_request('medication_requests?select=id&fee_paid=eq.true', 'GET');
    $totalPaid = is_array($paidResult['data']) ? count($paidResult['data']) : 0;
    $totalVolumeETB = $totalPaid * 20;

    // Registered users by role
    $patientsResult = supabase_request('profiles?select=id&role=eq.patient', 'GET');
    $totalPatients = is_array($patientsResult['data']) ? count($patientsResult['data']) : 0;

    $staffResult = supabase_request('profiles?select=id&role=eq.pharmacy_staff', 'GET');
    $totalStaff = is_array($staffResult['data']) ? count($staffResult['data']) : 0;

    // All requests for admin table
    $selectCols = 'id,patient_name,medication_name,status,pharmacy_id,notes,fee_paid,telebirr_ref,timestamp,updated_at,pharmacies(pharmacy_name,area,google_maps_link)';
    $allRequestsResult = supabase_request("medication_requests?select={$selectCols}&order=timestamp.desc&limit=50", 'GET');
    $allRequestsList = is_array($allRequestsResult['data']) ? $allRequestsResult['data'] : [];

    json_response([
        'total_active_requests' => $totalActive,
        'total_requests'        => $totalRequests,
        'total_pharmacies'      => $totalPharmacies,
        'total_volume_etb'      => $totalVolumeETB,
        'total_patients'        => $totalPatients,
        'total_pharmacy_staff'  => $totalStaff,
        'recent_requests'       => $allRequestsList,
    ]);
}

json_error('Unknown action. Use profile or stats.', 400);
