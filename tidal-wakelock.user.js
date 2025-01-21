'use strict;'
// ==UserScript==
// @name Tidal Playback Wakelock
// @description Sets a wakelock while Tidal is playing to keep the screen unlocked
// @match https://listen.tidal.com/*
// @version 0.2.2
// ==/UserScript==

class TidalPlaybackWatcher extends EventTarget {
	player;
	watching = false;
	state;
	observer;

	static state_map = {
			"PLAYING": 'playing',
			"STALLED": 'playing',

			"NOT_PLAYING": 'paused',
			"IDLE": 'paused',
		};

	constructor(player) {
		super();
		this.player = player;
		try {
			this.checkAttachable()
		}
		catch (e) {
			throw new Error(`Unable to watch playback state: ${e}`, {cause: e});
		}
		this.observer = new MutationObserver(this.attr_change_handler);
	}

	checkAttachable() {
		if(!this.player.dataset)
			throw new Error("player is missing 'dataset'");
		if(this.player.dataset.testPlaybackState === undefined)
			throw new Error("player is missing 'testPlaybackState' dataset value");
		if(!this.player.dataset.testPlaybackState)
			throw new Error("player 'testPlaybackState' is empty");
		if(!Object.keys(this.constructor.state_map).includes(this.player.dataset.testPlaybackState))
			throw new Error(`player 'testPlaybackState' has unrecognized state '${this.player.dataset.testPlaybackState}'`);
	}

	player_state() {
		const state = this.player.dataset.testPlaybackState;
		console.debug(`${this.constructor.name}: read state from tidal: ${state}`);
		return state;
	}

	update_state() {
		const old_state = this.state,
			tidal_state = this.player_state();
		if(tidal_state in this.constructor.state_map)
			this.state = this.constructor.state_map[tidal_state];
		else {
			console.warn(`${this.constructor.name}: unrecognized tidal state '${tidal_state}'`);
			this.state = 'paused';
		}

		if(this.state == old_state)
			return;
		console.info(`${this.constructor.name}: Detected playstate change: ${this.state}`);
		if(!this.watching)
			return;
		if(this.state == 'playing')
			this.dispatchEvent(new CustomEvent('play'));
		else if(this.state == 'paused')
			this.dispatchEvent(new CustomEvent('pause'));
	}

	attr_change_handler = mutList => {
		this.update_state();
	}

	watch() {
		if(this.watching)
			return;
		this.observer.observe(this.player, {attributes: true, attributeFilter: ['data-test-playback-state']});
		this.update_state();
		this.watching = true;
	}
}

class TidalWakelock extends EventTarget {
	watcher;
	wlock = null;
	wlock_tgt_state = false;
	update_promise = Promise.resolve();

	constructor(player) {
		super();
		this.watcher = new TidalPlaybackWatcher(player);
		this.watcher.addEventListener('play', this.get_lock);
		this.watcher.addEventListener('pause', this.release_lock);
		this.watcher.watch();
		if(this.watcher.state == 'playing')
			this.get_lock();
	}

	get_lock = () => {
		console.debug(`${this.constructor.name}: wlock_tgt_state: true`)
		this.wlock_tgt_state = true;
		this.update_promise.then(this.update_wlock);
	}

	release_lock = () => {
		console.debug(`${this.constructor.name}: wlock_tgt_state: false`)
		this.wlock_tgt_state = false;
		this.update_promise.then(this.update_wlock);
	}

	update_wlock = async () => {
		if(Boolean(this.wlock) == this.wlock_tgt_state)
			return;

		if(this.wlock_tgt_state) {
			console.info(`${this.constructor.name}: Requesting wakelock`);
			this.dispatchEvent(new CustomEvent('locking'));
			while(!this.wlock) {
				try {
					this.wlock = await navigator.wakeLock.request('screen');
				}
				catch (e) {
					console.info(`${this.constructor.name}: wakelock request failed: ${e.message}`);
					console.debug(`${this.constructor.name}: retrying wakelock request`);
					await new Promise(r => setTimeout(r, 5000));
				}
			}
			console.debug(`${this.constructor.name}: wakelock acquired`);
			this.dispatchEvent(new CustomEvent('locked'));
			this.wlock.addEventListener('release', this.lock_released);
		}
		else {
			console.info(`${this.constructor.name}: Releasing wakelock`);
			this.dispatchEvent(new CustomEvent('releasing'));
			await this.wlock.release();
			console.debug(`${this.constructor.name}: Release request complete`);
		}

		if(Boolean(this.wlock) != this.wlock_tgt_state)
			this.update_promise.then(this.update_wlock);
	}

	lock_released = e => {
		this.wlock = null;
		console.debug(`${this.constructor.name}: wakelock released`);
		// relock if released by browser
		if(this.wlock_tgt_state) {
			console.debug(`${this.constructor.name}: Queueing relock`);
			this.dispatchEvent(new CustomEvent('relocking'));
			setTimeout(this.update_wlock, 1000);
		}
		else
			this.dispatchEvent(new CustomEvent('released'));
	}

	get state() {
		if(Boolean(this.wlock) != this.wlock_tgt_state)
			return this.wlock_tgt_state ? 'locking' : 'unlocking';
		else
			return this.wlock_tgt_state ? 'locked' : 'unlocked';
	}
}

class WakelockStatusComponent {
	player;
	wlock;
	node;

	static css_text = `
			<style>
				.wakelock-status-component {
					display: block;
					box-sizing: border-box;
					position: absolute;
					bottom: 5px;
					left: 5px;
					width: 10px;
					height: 10px;
					border-radius: 50%;
					background: var(--indicator-color, #c00);
					box-shadow: 0 0 4px 1px var(--indicator-color, #c00);
				}

				.wakelock-status-component[data-state=idle] {
					--indicator-color: #555;
				}

				.wakelock-status-component[data-state=working] {
					--indicator-color: #ca3;
					animation: 0.6s ease-in infinite alternate wakelock-status-component_fade;
				}

				.wakelock-status-component[data-state=locked] {
					--indicator-color: #181;
				}

				@keyframes wakelock-status-component_fade {
					from {
						filter: opacity(100%);
					}

					to {
						filter: opacity(0%);
					}
				}
			</style>
		`;
	static html_text = `
			<aside class="wakelock-status-component" title="Screen wakelock status"></aside>
		`;

	static css_tpl;
	static html_tpl;
	static css_injected = false;

	constructor(player, tidal_wlock) {
		this.player = player;
		this.wlock = tidal_wlock;

		this.init_tpls();
		this.attach();
		this.set_working();
		this.bind_events();
		const state = this.wlock.state;
		if(state == 'locking' || state == 'unlocking')
			this.set_working();
		else if(state == 'locked')
			this.set_locked();
		else
			this.set_idle();
	}

	init_tpls() {
		if(!this.constructor.css_tpl) {
			this.constructor.css_tpl = document.createElement('template');
			this.constructor.css_tpl.innerHTML = this.constructor.css_text;
		}
		if(!this.constructor.html_tpl) {
			this.constructor.html_tpl = document.createElement('template');
			this.constructor.html_tpl.innerHTML = this.constructor.html_text;
		}
	}

	attach() {
		if(!this.constructor.css_injected)
			document.head.append(document.importNode(this.constructor.css_tpl.content, true));
		if(this.node)
			this.node.remove();
		let tpl = document.importNode(this.constructor.html_tpl.content, true);
		this.node = tpl.querySelector('.wakelock-status-component');
		this.player.append(tpl);
	}

	set_working = () => { this.node.dataset.state = 'working'; }
	set_locked = () => { this.node.dataset.state = 'locked'; }
	set_idle = () => { this.node.dataset.state = 'idle'; }

	bind_events() {
		this.wlock.addEventListener('locking', this.set_working);
		this.wlock.addEventListener('relocking', this.set_working);

		this.wlock.addEventListener('locked', this.set_locked);

		this.wlock.addEventListener('released', this.set_idle);
	}
}

let tries = 30,  // try for up to 60 seconds
	attach_handle;
attach_handle = setInterval(() => {
		if(--tries <= 0)
			clearInterval(attach_handle);
		try {
			console.debug("Searching for player element '#footerPlayer'");
			let player = document.getElementById('footerPlayer');
			if(!player) {
				if(tries)
					return;  // wait for next try
				console.error("Failed to find player '#footerPlayer'");
				throw new Error("'#footerPlayer' element not found");
			}
			console.debug("Player found: %o", player);
			clearInterval(attach_handle);
			let wl = new TidalWakelock(player);
			console.info("TidalWakelock attached to player");
			new WakelockStatusComponent(player, wl);
			console.debug("WakelockStatusComponent attached to player");
		}
		catch (e) {
			console.error(e);
			alert(`Error connecting to Tidal: ${e}`);
		}
	}, 2000);
