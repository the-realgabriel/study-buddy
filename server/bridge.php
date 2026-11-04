<?php
// Study Buddy database bridge.
// Place at e.g. /opt/lampp/htdocs/studybuddy-db/index.php and serve over HTTPS.
// Replace the placeholders below, then set the same secret on the Worker:
//   npx wrangler secret put BRIDGE_SECRET

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$expected = '__BRIDGE_SECRET__';
$provided = $_SERVER['HTTP_X_BRIDGE_SECRET'] ?? '';
if (!is_string($provided) || !hash_equals($expected, $provided)) {
    http_response_code(403);
    echo json_encode(['error' => 'Forbidden']);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

$raw = file_get_contents('php://input');
$body = json_decode($raw ?: '{}', true);
if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid JSON']);
    exit;
}

try {
    $pdo = new PDO(
        'mysql:host=127.0.0.1;port=3306;dbname=studybuddy;charset=utf8mb4',
        '__DB_USER__',
        '__DB_PASSWORD__',
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]
    );

    if (isset($body['batch']) && is_array($body['batch'])) {
        $pdo->beginTransaction();
        try {
            foreach ($body['batch'] as $item) {
                $stmt = $pdo->prepare((string)($item['sql'] ?? ''));
                $stmt->execute(is_array($item['params'] ?? null) ? array_values($item['params']) : []);
            }
            $pdo->commit();
            echo json_encode(['ok' => true]);
            exit;
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    $sql = (string)($body['sql'] ?? '');
    $params = is_array($body['params'] ?? null) ? array_values($body['params']) : [];
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->columnCount() > 0 ? $stmt->fetchAll() : [];
    $insertId = (int)$pdo->lastInsertId();
    echo json_encode(['rows' => $rows, 'insertId' => $insertId]);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
