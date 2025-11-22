// Minimal Web Playback SDK initialization
// This script loads the Spotify SDK and attempts to create a player using a token
// It requires the server endpoint GET /spotify/token to return a JSON { access_token }

window.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('start-spotify-player');
  if (!startBtn) return;

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';

    try {
      // load SDK script if not present
      if (!window.Spotify) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://sdk.scdn.co/spotify-player.js';
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }

      // request token from server
      const tokenResp = await fetch('/spotify/token');
      if (!tokenResp.ok) throw new Error('No spotify token (are you signed in?)');
      const { access_token } = await tokenResp.json();

      window.onSpotifyWebPlaybackSDKReady = () => {
        const player = new Spotify.Player({
          name: 'My Study Player',
          getOAuthToken: cb => { cb(access_token); },
          volume: 0.6
        });

        // Error handling
        player.addListener('initialization_error', ({ message }) => { console.error(message); alert('Player init error: ' + message); });
        player.addListener('authentication_error', ({ message }) => { console.error(message); alert('Auth error: ' + message); });
        player.addListener('account_error', ({ message }) => { console.error(message); alert('Account error: ' + message + '\nSpotify Web Playback SDK requires a Premium account.'); });
        player.addListener('playback_error', ({ message }) => { console.error(message); });

        // Playback status updates
        player.addListener('player_state_changed', state => { console.log('player state', state); });

        // Ready
        player.addListener('ready', ({ device_id }) => {
          console.log('Ready with Device ID', device_id);

          // attempt to transfer playback to the new device and play nothing (user needs to play)
          fetch('https://api.spotify.com/v1/me/player', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + access_token
            },
            body: JSON.stringify({ device_ids: [device_id], play: false })
          }).then(r => {
            if (!r.ok) console.warn('transfer playback failed', r.status);
            else console.log('transferred playback to device', device_id);
          }).catch(err => console.error(err));

          startBtn.textContent = 'Player ready - use Spotify app or this page to play';
        });

        // Connect!
        player.connect();
      };

      // If SDK already loaded, call ready handler
      if (window.Spotify && window.Spotify.Player) window.onSpotifyWebPlaybackSDKReady();

    } catch (err) {
      console.error(err);
      alert('Could not start Spotify player: ' + (err.message || err));
      startBtn.disabled = false;
      startBtn.textContent = 'Start Spotify Player';
    }
  });
});
