/**
 * The bell's sound: two soft notes, made in the browser (no file to fetch). Quiet by design — it says "look at
 * the bell", nothing more. A browser that has not yet been clicked in refuses sound; that is its rule, and the
 * bell's colour still tells.
 */
let context: AudioContext | null = null;

export function chime(): void {
    try {
        const Audio = window.AudioContext;
        if (!Audio) return;
        context ??= new Audio();
        const audio = context;
        if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
        const start = audio.currentTime;
        for (const [i, frequency] of [880, 1174.66].entries()) {
            const at = start + i * 0.14;
            const tone = audio.createOscillator();
            const volume = audio.createGain();
            tone.type = 'sine';
            tone.frequency.value = frequency;
            volume.gain.setValueAtTime(0.0001, at);
            volume.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
            volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
            tone.connect(volume).connect(audio.destination);
            tone.start(at);
            tone.stop(at + 0.5);
        }
    } catch {
        // No sound is not an error worth telling anyone about.
    }
}
