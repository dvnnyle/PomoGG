-- Create table for bot admins
CREATE TABLE IF NOT EXISTS admins (
    user_id TEXT PRIMARY KEY,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_admins_user ON admins(user_id);

-- Insert your user ID as the first admin (replace with your Discord user ID)
-- To get your user ID: Enable Developer Mode in Discord, right-click your name, Copy ID
-- INSERT INTO admins (user_id) VALUES ('YOUR_USER_ID_HERE');
