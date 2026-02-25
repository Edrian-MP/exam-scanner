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

CREATE TABLE IF NOT EXISTS educators (
  id INT AUTO_INCREMENT PRIMARY KEY,
  surname VARCHAR(180) NOT NULL,
  email VARCHAR(180) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  profile_photo_data MEDIUMTEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_educator_email (email)
);

CREATE TABLE IF NOT EXISTS subjects (
  id INT AUTO_INCREMENT PRIMARY KEY,
  educator_id INT NOT NULL,
  subject_code VARCHAR(40) NOT NULL,
  title VARCHAR(160) NOT NULL,
  term_label VARCHAR(80) NULL,
  description TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_subjects_educator_id (educator_id),
  UNIQUE KEY uq_subject_code_per_educator (educator_id, subject_code),
  CONSTRAINT fk_subjects_educator FOREIGN KEY (educator_id) REFERENCES educators(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS students (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_code VARCHAR(64) NOT NULL,
  surname VARCHAR(180) NOT NULL,
  given_name VARCHAR(120) NULL,
  middle_name VARCHAR(120) NULL,
  email VARCHAR(180) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_student_code (student_code)
);

CREATE TABLE IF NOT EXISTS subject_students (
  subject_id INT NOT NULL,
  student_id INT NOT NULL,
  enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (subject_id, student_id),
  INDEX idx_subject_students_student_id (student_id),
  CONSTRAINT fk_subject_students_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_subject_students_student FOREIGN KEY (student_id) REFERENCES students(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS subject_activities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subject_id INT NOT NULL,
  title VARCHAR(180) NOT NULL,
  activity_type VARCHAR(24) NOT NULL DEFAULT 'exam',
  exam_id INT NULL,
  max_score INT NOT NULL DEFAULT 100,
  due_at DATETIME NULL,
  publish_status VARCHAR(16) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_subject_activities_subject_id (subject_id),
  INDEX idx_subject_activities_exam_id (exam_id),
  CONSTRAINT fk_subject_activities_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_subject_activities_exam FOREIGN KEY (exam_id) REFERENCES exams(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS subject_announcements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subject_id INT NOT NULL,
  title VARCHAR(180) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_subject_announcements_subject_id (subject_id),
  CONSTRAINT fk_subject_announcements_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);
