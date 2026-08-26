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

-- 价值投注机器人 - 初盘状态表
CREATE TABLE IF NOT EXISTS value_bot_match_state (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(100) NOT NULL,
  home_team VARCHAR(200) NOT NULL,
  away_team VARCHAR(200) NOT NULL,
  lambda_home DECIMAL(8,4) NOT NULL,
  lambda_away DECIMAL(8,4) NOT NULL,
  initial_home_prob DECIMAL(8,4) NOT NULL,
  initial_draw_prob DECIMAL(8,4) NOT NULL,
  initial_away_prob DECIMAL(8,4) NOT NULL,
  bzzoiro_event_id BIGINT DEFAULT NULL,
  source VARCHAR(20) DEFAULT 'polymarket',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_event (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 价值投注机器人 - 记录表
CREATE TABLE IF NOT EXISTS value_bet_records (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  bot_id VARCHAR(50) NOT NULL,
  polymarket_event_id VARCHAR(100) NOT NULL,
  bzzoiro_event_id BIGINT DEFAULT NULL,
  market_id VARCHAR(100) NOT NULL,
  market_type VARCHAR(50) NOT NULL,
  question VARCHAR(500) DEFAULT NULL,
  outcome VARCHAR(100) NOT NULL,
  handicap DECIMAL(10,3) DEFAULT NULL,
  model_probability DECIMAL(8,4) NOT NULL,
  market_price DECIMAL(8,4) NOT NULL,
  implied_probability DECIMAL(8,4) NOT NULL,
  edge DECIMAL(8,4) NOT NULL,
  match_minute INT NOT NULL,
  current_score VARCHAR(20) NOT NULL,
  lambda_home DECIMAL(8,4) NOT NULL,
  lambda_away DECIMAL(8,4) NOT NULL,
  recommendation VARCHAR(20) NOT NULL,
  status VARCHAR(20) DEFAULT 'recorded',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_bot (bot_id),
  KEY idx_event (polymarket_event_id),
  KEY idx_created (created_at),
  KEY idx_edge (edge)
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
