-- Study Buddy — MariaDB schema.
-- Run as root (or a user with rights) via phpMyAdmin's SQL tab or:
--   mariadb < mysql/schema.sql

CREATE DATABASE IF NOT EXISTS studybuddy
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE studybuddy;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(32) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  token CHAR(64) PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  KEY idx_sessions_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  content LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  KEY idx_notes_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS quizzes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  note_id INT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  questions LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_quizzes_note (note_id),
  KEY idx_quizzes_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS attempts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  quiz_id INT UNSIGNED NOT NULL,
  score INT NOT NULL,
  total INT NOT NULL,
  results LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_attempts_quiz (quiz_id),
  KEY idx_attempts_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS files (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  note_id INT UNSIGNED NULL,
  filename VARCHAR(255) NOT NULL,
  mime VARCHAR(128) NOT NULL,
  text LONGTEXT NULL,
  size INT UNSIGNED NOT NULL,
  r2_key VARCHAR(255) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_files_user (user_id),
  KEY idx_files_note (note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
