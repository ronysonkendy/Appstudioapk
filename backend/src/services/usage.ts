import { pool } from "../db/pool.js";

// Espacio usado por una cuenta: APK originales + compilaciones exitosas.
export async function userStorage(uid: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE((SELECT SUM(size_bytes) FROM projects WHERE owner_id=$1), 0)
          + COALESCE((SELECT SUM(b.size_bytes) FROM builds b JOIN projects p ON p.id=b.project_id
                      WHERE p.owner_id=$1 AND b.status='success'), 0) AS total`, [uid]);
  return Number(rows[0].total);
}
