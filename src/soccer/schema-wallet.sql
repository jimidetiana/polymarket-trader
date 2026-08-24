-- 钱包余额表
CREATE TABLE IF NOT EXISTS soccer_wallets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  wallet_address VARCHAR(80) NOT NULL UNIQUE,
  balance_usdc DECIMAL(24, 6) DEFAULT 0.000000,
  total_deposited DECIMAL(24, 6) DEFAULT 0.000000,
  total_withdrawn DECIMAL(24, 6) DEFAULT 0.000000,
  total_pnl DECIMAL(24, 6) DEFAULT 0.000000,
  chain_balance DECIMAL(24, 6) DEFAULT NULL,
  last_sync_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_address (wallet_address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 钱包流水表（充值、提现、交易盈亏等）
CREATE TABLE IF NOT EXISTS soccer_wallet_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  wallet_address VARCHAR(80) NOT NULL,
  tx_type ENUM('deposit', 'withdraw', 'trade_pnl', 'fee', 'other') NOT NULL,
  amount DECIMAL(24, 6) NOT NULL,
  balance_after DECIMAL(24, 6) DEFAULT NULL,
  order_id BIGINT DEFAULT NULL,
  tx_hash VARCHAR(120) DEFAULT NULL,
  description VARCHAR(500) DEFAULT NULL,
  status ENUM('pending', 'completed', 'failed') DEFAULT 'completed',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_wallet (wallet_address),
  KEY idx_type (tx_type),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
