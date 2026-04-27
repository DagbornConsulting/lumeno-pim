import React, { useState } from 'react';
import { Lock, Loader2, AlertCircle, Mail } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();

      if (res.ok && data.success) {
        localStorage.setItem('pim_token', data.token);
        localStorage.setItem('pim_user', JSON.stringify(data.user));
        onLogin(data.token, data.user);
      } else {
        setError(data.error || 'Felaktig e-post eller lösenord');
      }
    } catch (err) {
      setError('Kunde inte ansluta till servern');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-box">
        <div className="login-header">
          <div className="login-icon">
            <Lock size={32} />
          </div>
          <h1>Lumeno</h1>
          <p>Logga in för att fortsätta</p>
        </div>

        <form onSubmit={handleSubmit}>
          {error && (
            <div className="login-error">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          <div className="login-field">
            <label>E-post</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Ange e-postadress"
              autoFocus
              disabled={loading}
            />
          </div>

          <div className="login-field">
            <label>Lösenord</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Ange lösenord"
              disabled={loading}
            />
          </div>

          <button type="submit" className="login-button" disabled={loading || !email || !password}>
            {loading ? <Loader2 size={18} className="spin" /> : <Lock size={18} />}
            {loading ? 'Loggar in...' : 'Logga in'}
          </button>
        </form>
      </div>
    </div>
  );
}
