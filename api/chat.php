<?php
/**
 * api/chat.php
 * POST /api/chat.php
 * body: { "message": "string", "history": [ {role, content}, ... ] (optional) }
 *
 * Proxies a chat completion request to the Groq API (server-side, key never exposed to client).
 * Model: llama3-8b-8192 (fast, cheap, good enough for drug-info Q&A demo).
 */

require_once __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method not allowed.', 405);
}

if (GROQ_API_KEY === '') {
    json_error('GROQ_API_KEY is not configured on the server.', 500);
}

$body = read_json_body();
$userMessage = trim($body['message'] ?? '');

if ($userMessage === '') {
    json_error('message is required.', 422);
}

// Keep prior turns if the frontend sends them, so the assistant has conversational memory.
$history = is_array($body['history'] ?? null) ? $body['history'] : [];

$systemPrompt = <<<EOT
You are "Miftah", a helpful pharmacy-literacy assistant embedded in the MedSync
(Felega Health) app for patients in Addis Ababa, Ethiopia.

Your job:
- Explain the difference between generic and brand drug names in plain language.
- Explain typical dosage directions and what they mean (you are NOT a doctor — always include
  a brief safety reminder for anything dosage-related).
- Suggest common substitutes / generic equivalents for medications when asked.
- Be concise, warm, and clear. Use simple language, avoid unnecessary jargon.
- If asked about anything outside medication/pharmacy literacy, gently redirect back to how you
  can help with medication questions.
- Never claim to replace a licensed pharmacist or doctor. For dosing of a specific patient
  (children, pregnancy, chronic conditions), always recommend confirming with the pharmacist
  they are about to meet in person through MedSync.
- Keep answers short (3-6 sentences) unless the user asks for more detail — this is a chat widget,
  not a long-form article.
EOT;

$messages = [
    ['role' => 'system', 'content' => $systemPrompt],
];

// Append prior turns (trim role/content to expected keys only, basic sanitation)
foreach ($history as $turn) {
    if (!isset($turn['role'], $turn['content'])) continue;
    if (!in_array($turn['role'], ['user', 'assistant'], true)) continue;
    $messages[] = ['role' => $turn['role'], 'content' => (string)$turn['content']];
}

$messages[] = ['role' => 'user', 'content' => $userMessage];

$payload = [
    'model' => 'openai/gpt-oss-120b',
    'messages' => $messages,
    'temperature' => 0.4,
    'max_tokens' => 500,
];

$ch = curl_init('https://api.groq.com/openai/v1/chat/completions');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer ' . GROQ_API_KEY,
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS => json_encode($payload),
    CURLOPT_TIMEOUT => 30,
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr = curl_error($ch);
curl_close($ch);

if ($response === false) {
    json_error('Failed to reach Groq API: ' . $curlErr, 502);
}

$decoded = json_decode($response, true);

if ($httpCode !== 200 || !isset($decoded['choices'][0]['message']['content'])) {
    $errMsg = $decoded['error']['message'] ?? 'Unknown error from Groq API.';
    json_error('Groq API error: ' . $errMsg, $httpCode ?: 502);
}

$reply = $decoded['choices'][0]['message']['content'];

json_response([
    'reply' => $reply,
    'model' => 'openai/gpt-oss-120b',
]);
