CREATE DATABASE IF NOT EXISTS polymarket_soccer
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE polymarket_soccer;

CREATE TABLE IF NOT EXISTS soccer_events (
  id BIGINT PRIMARY KEY,
  slug VARCHAR(255) NOT NULL UNIQUE,
  title_en VARCHAR(500) NOT NULL,
  title_zh VARCHAR(500) DEFAULT NULL,
  league VARCHAR(120) DEFAULT NULL,
  home_team_en VARCHAR(200) DEFAULT NULL,
  away_team_en VARCHAR(200) DEFAULT NULL,
  home_team_zh VARCHAR(200) DEFAULT NULL,
  away_team_zh VARCHAR(200) DEFAULT NULL,
  start_time DATETIME DEFAULT NULL,
  end_time DATETIME DEFAULT NULL,
  volume DECIMAL(24,8) DEFAULT 0,
  liquidity DECIMAL(24,8) DEFAULT 0,
  event_status VARCHAR(20) DEFAULT 'active',
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_end_time (end_time),
  KEY idx_status (event_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS soccer_markets (
  id BIGINT PRIMARY KEY,
  event_id BIGINT NOT NULL,
  question_en VARCHAR(500) NOT NULL,
  question_zh VARCHAR(500) DEFAULT NULL,
  market_type VARCHAR(50) DEFAULT 'other',
  line DECIMAL(10,3) DEFAULT NULL,
  outcomes JSON DEFAULT NULL,
  outcome_prices JSON DEFAULT NULL,
  clob_token_ids JSON DEFAULT NULL,
  volume DECIMAL(24,8) DEFAULT 0,
  liquidity DECIMAL(24,8) DEFAULT 0,
  best_bid DECIMAL(8,4) DEFAULT NULL,
  best_ask DECIMAL(8,4) DEFAULT NULL,
  market_status VARCHAR(20) DEFAULT 'active',
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_event (event_id),
  KEY idx_type (market_type),
  KEY idx_status (market_status),
  CONSTRAINT fk_market_event FOREIGN KEY (event_id) REFERENCES soccer_events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS soccer_orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  market_id BIGINT NOT NULL,
  token_id VARCHAR(80) NOT NULL,
  side ENUM('BUY','SELL') NOT NULL,
  size DECIMAL(24,8) NOT NULL,
  price DECIMAL(8,4) NOT NULL,
  order_status VARCHAR(30) DEFAULT 'pending',
  memo VARCHAR(500) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_market (market_id),
  KEY idx_status (order_status),
  CONSTRAINT fk_order_market FOREIGN KEY (market_id) REFERENCES soccer_markets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
