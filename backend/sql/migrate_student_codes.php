<?php
/**
 * One-time migration: assigns 6-digit zero-padded sequential student codes
 * to all existing students ordered by id. Updates the submissions table to
 * match. Idempotent — students already on a 6-digit numeric code are skipped.
 *
 * Run once via CLI:  php migrate_student_codes.php
 * Or visit the URL:  /exam-scanner/backend/sql/migrate_student_codes.php
 *                    (restrict access in production)
 */

declare(strict_types=1);

require __DIR__ . '/../api/lib/db.php';

$cfg = app_config();
$pdo = db();

echo "=== Student Code Migration ===\n\n";

// Fetch all students ordered by id
$students = $pdo->query('SELECT id, student_code FROM students ORDER BY id ASC')->fetchAll(PDO::FETCH_ASSOC);

if (!$students) {
    echo "No students found. Nothing to migrate.\n";
    exit(0);
}

$counter   = 1;
$mapping   = [];   // old_code => new_code
$migrated  = 0;
$skipped   = 0;

$pdo->beginTransaction();
try {
    foreach ($students as $student) {
        $id      = (int) $student['id'];
        $oldCode = (string) $student['student_code'];

        // Skip if already 6-digit numeric
        if (preg_match('/^[0-9]{6}$/', $oldCode)) {
            // Advance counter past this code so we don't collide
            $num = (int) $oldCode;
            if ($num >= $counter) {
                $counter = $num + 1;
            }
            $skipped++;
            continue;
        }

        $newCode = str_pad((string) $counter, 6, '0', STR_PAD_LEFT);
        $counter++;

        // Update students table
        $upd = $pdo->prepare('UPDATE students SET student_code = :new WHERE id = :id');
        $upd->execute([':new' => $newCode, ':id' => $id]);

        // Update submissions table (student_code is denormalised there)
        $upd2 = $pdo->prepare('UPDATE submissions SET student_code = :new WHERE student_code = :old');
        $upd2->execute([':new' => $newCode, ':old' => $oldCode]);

        $mapping[$oldCode] = $newCode;
        $migrated++;
    }

    $pdo->commit();
} catch (Throwable $e) {
    $pdo->rollBack();
    echo "ERROR: " . $e->getMessage() . "\n";
    exit(1);
}

echo "Migrated : $migrated student(s)\n";
echo "Skipped  : $skipped student(s) (already 6-digit numeric)\n\n";

if ($mapping) {
    echo "Mapping (old → new):\n";
    echo str_repeat('-', 32) . "\n";
    foreach ($mapping as $old => $new) {
        echo "  $old  →  $new\n";
    }

    // Write CSV mapping file alongside this script
    $csvPath = __DIR__ . '/student_code_mapping.csv';
    $fp = fopen($csvPath, 'w');
    fputcsv($fp, ['old_code', 'new_code']);
    foreach ($mapping as $old => $new) {
        fputcsv($fp, [$old, $new]);
    }
    fclose($fp);
    echo "\nCSV saved to: $csvPath\n";
}

echo "\nDone.\n";
