// SPDX-License-Identifier: AGPL-3.0-or-later
// UTF-8 bridge to the pinned sherpa-onnx 1.13.8 C API. The upstream Windows
// CLI uses ANSI argv, which corrupts Portuguese accents on code page 1252.
using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Collections.Generic;

class VoiceWindows {
    const string Dll = "sherpa-onnx-c-api.dll";
    [StructLayout(LayoutKind.Sequential)] struct Vits {
        public IntPtr model, lexicon, tokens, data;
        public float noise, noiseW, length;
        public IntPtr dict;
    }
    [StructLayout(LayoutKind.Sequential, Size=56)] struct Matcha { }
    [StructLayout(LayoutKind.Sequential)] struct Kokoro {
        public IntPtr model, voices, tokens, data;
        public float length;
        public IntPtr dict, lexicon, lang;
    }
    [StructLayout(LayoutKind.Sequential, Size=40)] struct Kitten { }
    [StructLayout(LayoutKind.Sequential, Size=64)] struct Zipvoice { }
    [StructLayout(LayoutKind.Sequential, Size=64)] struct Pocket { }
    [StructLayout(LayoutKind.Sequential, Size=56)] struct Supertonic { }
    [StructLayout(LayoutKind.Sequential)] struct Models {
        public Vits vits; public int threads, debug; public IntPtr provider;
        public Matcha matcha; public Kokoro kokoro; public Kitten kitten;
        public Zipvoice zipvoice; public Pocket pocket; public Supertonic supertonic;
    }
    [StructLayout(LayoutKind.Sequential)] struct Config {
        public Models model; public IntPtr rules; public int maxSentences;
        public IntPtr fars; public float silence;
    }
    [StructLayout(LayoutKind.Sequential)] struct Audio {
        public IntPtr samples; public int count, rate;
    }
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetDllDirectory(string path);
    [DllImport(Dll, CallingConvention=CallingConvention.Cdecl)] static extern IntPtr SherpaOnnxCreateOfflineTts(ref Config config);
    [DllImport(Dll, CallingConvention=CallingConvention.Cdecl)] static extern void SherpaOnnxDestroyOfflineTts(IntPtr tts);
    [DllImport(Dll, CallingConvention=CallingConvention.Cdecl)] static extern IntPtr SherpaOnnxOfflineTtsGenerate(IntPtr tts, IntPtr text, int sid, float speed);
    [DllImport(Dll, CallingConvention=CallingConvention.Cdecl)] static extern void SherpaOnnxDestroyOfflineTtsGeneratedAudio(IntPtr audio);
    static List<IntPtr> strings = new List<IntPtr>();
    static IntPtr Utf8(string value) {
        byte[] bytes = Encoding.UTF8.GetBytes(value+"\0");
        IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes,0,ptr,bytes.Length); strings.Add(ptr); return ptr;
    }
    static int Main(string[] args) {
        IntPtr tts=IntPtr.Zero, audioPtr=IntPtr.Zero;
        try {
            if (args.Length!=6) throw new ArgumentException("Expected family, modelDir, runtimeDir, output.wav, speakerId, speed; UTF-8 text on stdin.");
            if (IntPtr.Size!=8 || Marshal.SizeOf(typeof(Config))!=448 || Marshal.SizeOf(typeof(Models))!=416) throw new Exception("C API ABI mismatch; requires x64 sherpa-onnx 1.13.8.");
            string family=args[0], modelDir=Path.GetFullPath(args[1]), runtimeDir=Path.GetFullPath(args[2]), output=Path.GetFullPath(args[3]);
            int speaker=int.Parse(args[4],CultureInfo.InvariantCulture);
            float speed=float.Parse(args[5],CultureInfo.InvariantCulture);
            if (speed<0.5f || speed>2 || float.IsNaN(speed)) throw new ArgumentException("Invalid speed");
            if (family!="kokoro" && family!="jeff") throw new ArgumentException("Invalid model family");
            if (!output.EndsWith(".wav",StringComparison.OrdinalIgnoreCase) || File.Exists(output)) throw new IOException("Output must be a new WAV file");
            Console.InputEncoding = new UTF8Encoding(false,true);
            string text=Console.In.ReadToEnd().Trim();
            if(text.Length==0 || text.Length>4000) throw new ArgumentException("Text must contain 1-4000 characters");
            Environment.SetEnvironmentVariable("PATH",Path.Combine(runtimeDir,"bin")+Path.PathSeparator+Environment.GetEnvironmentVariable("PATH"));
            if (!SetDllDirectory(Path.Combine(runtimeDir,"lib"))) throw new Exception("Cannot locate native runtime");
            Config config=new Config();
            config.model.threads=4; config.model.provider=Utf8("cpu"); config.maxSentences=1; config.silence=0.2f;
            if(family=="kokoro") {
                if(speaker<42 || speaker>44) throw new ArgumentException("Select a Brazilian voice (42-44)");
                config.model.kokoro.model=Utf8(Path.Combine(modelDir,"model.int8.onnx"));
                config.model.kokoro.tokens=Utf8(Path.Combine(modelDir,"tokens.txt"));
                config.model.kokoro.voices=Utf8(Path.Combine(modelDir,"voices.bin"));
                config.model.kokoro.data=Utf8(Path.Combine(modelDir,"espeak-ng-data"));
                config.model.kokoro.lang=Utf8("pt-br"); config.model.kokoro.length=1;
            } else {
                speaker=0;
                config.model.vits.model=Utf8(Path.Combine(modelDir,"pt_BR-jeff-medium.onnx"));
                config.model.vits.tokens=Utf8(Path.Combine(modelDir,"tokens.txt"));
                config.model.vits.data=Utf8(Path.Combine(modelDir,"espeak-ng-data"));
                config.model.vits.noise=0.667f; config.model.vits.noiseW=0.8f; config.model.vits.length=1;
            }
            tts=SherpaOnnxCreateOfflineTts(ref config);
            if(tts==IntPtr.Zero) throw new Exception("Unable to load speech model");
            audioPtr=SherpaOnnxOfflineTtsGenerate(tts,Utf8(text),speaker,speed);
            if(audioPtr==IntPtr.Zero) throw new Exception("Speech generation failed");
            Audio audio=(Audio)Marshal.PtrToStructure(audioPtr,typeof(Audio));
            if(audio.count<=0 || audio.rate<8000 || audio.samples==IntPtr.Zero) throw new Exception("Empty or invalid speech");
            float[] samples=new float[audio.count]; Marshal.Copy(audio.samples,samples,0,samples.Length);
            using(var file=new FileStream(output,FileMode.CreateNew,FileAccess.Write,FileShare.None))
            using(var writer=new BinaryWriter(file)) {
                writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(36+audio.count*2);
                writer.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16); writer.Write((short)1); writer.Write((short)1);
                writer.Write(audio.rate); writer.Write(audio.rate*2); writer.Write((short)2); writer.Write((short)16);
                writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(audio.count*2);
                foreach(float sample in samples) writer.Write((short)(Math.Max(-1,Math.Min(1,sample))*32767));
            }
            Console.WriteLine("WAV_OK samples="+audio.count+" sampleRate="+audio.rate); return 0;
        } catch(Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
        finally {
            if(audioPtr!=IntPtr.Zero) SherpaOnnxDestroyOfflineTtsGeneratedAudio(audioPtr);
            if(tts!=IntPtr.Zero) SherpaOnnxDestroyOfflineTts(tts);
            foreach(IntPtr ptr in strings) Marshal.FreeHGlobal(ptr);
        }
    }
}
