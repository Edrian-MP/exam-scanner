CREATE DATABASE IF NOT EXISTS exam_scanner CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE exam_scanner;

CREATE TABLE IF NOT EXISTS exams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  total_items INT NOT NULL,
  answer_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scan_jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  exam_id INT NOT NULL,
  status VARCHAR(30) NOT NULL,
  raw_payload JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_scan_exam_id (exam_id),
  CONSTRAINT fk_scan_exam FOREIGN KEY (exam_id) REFERENCES exams(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS submissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  exam_id INT NOT NULL,
  exam_title VARCHAR(200) NULL,
  student_code VARCHAR(64) NOT NULL,
  answers TEXT NOT NULL,
  score INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sub_exam_id (exam_id),
  INDEX idx_sub_student_code (student_code),
  CONSTRAINT fk_sub_exam FOREIGN KEY (exam_id) REFERENCES exams(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);
