import argparse
import json
import sys
from pathlib import Path

from faster_whisper import WhisperModel

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def transcribe_one(model, audio_path):
    segments, info = model.transcribe(
        str(audio_path),
        language="en",
        task="transcribe",
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
        condition_on_previous_text=False,
    )

    words = []
    segment_texts = []
    for segment in segments:
        segment_text = (segment.text or "").strip()
        if segment_text:
            segment_texts.append(segment_text)
        for word in segment.words or []:
            text = (word.word or "").strip()
            if text:
                words.append({"text": text, "start": round(float(word.start or 0), 2)})

    if words:
        script = " ".join(item["text"] for item in words)
        word_times = {str(index): item["start"] for index, item in enumerate(words)}
    else:
        script = " ".join(segment_texts).strip()
        word_times = {}

    return {
        "script": script,
        "wordTimes": word_times,
        "language": getattr(info, "language", "en"),
        "languageProbability": round(float(getattr(info, "language_probability", 0) or 0), 4),
        "generatedBy": "faster-whisper",
    }


def main():
    parser = argparse.ArgumentParser(description="Transcribe uploaded audio files.")
    parser.add_argument("job_file")
    parser.add_argument("--model", default="base")
    args = parser.parse_args()

    job = json.loads(Path(args.job_file).read_text(encoding="utf-8"))
    audio_root = Path(job["audioRoot"]).resolve()
    track_ids = job.get("tracks", [])

    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    emit({"type": "ready", "total": len(track_ids)})

    for track_id in track_ids:
        emit({"type": "progress", "trackId": track_id})
        try:
            audio_path = (audio_root / Path(track_id)).resolve()
            audio_path.relative_to(audio_root)
            transcript = transcribe_one(model, audio_path)
            transcript["generatedBy"] = f"faster-whisper:{args.model}"
            emit({"type": "result", "trackId": track_id, "transcript": transcript})
        except Exception as error:
            emit({"type": "error", "trackId": track_id, "error": str(error)})

    emit({"type": "complete"})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise
