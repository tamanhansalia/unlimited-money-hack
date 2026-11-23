import tempfile
import unittest
import wave
from pathlib import Path

from faster_whisper.audio import decode_audio


class TranscriptionTests(unittest.TestCase):
    def test_whisper_decodes_audio_from_a_file(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory, "speech.wav")
            with wave.open(str(audio), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(b"\x00\x20" * 1600)

            samples = decode_audio(str(audio))

        self.assertEqual(samples.shape, (1600,))
        self.assertAlmostEqual(float(samples[800]), 0.25)


if __name__ == "__main__":
    unittest.main()
