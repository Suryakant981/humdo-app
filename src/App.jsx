import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabase'
import './App.css'

function App() {
  // Auth states
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [isSignup, setIsSignup] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  
  // User states
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [partnerProfile, setPartnerProfile] = useState(null)
  
  // Partner connection
  const [partnerUsername, setPartnerUsername] = useState('')
  const [conversation, setConversation] = useState(null)
  
  // Chat states
  const [messages, setMessages] = useState([])
  const [newMessage, setNewMessage] = useState('')
  const messagesEndRef = useRef(null)

  // Call states
  const [callState, setCallState] = useState('idle') // idle, calling, incoming, connected
  const [callType, setCallType] = useState(null) // audio, video
  const [incomingCall, setIncomingCall] = useState(null)
  const [callDuration, setCallDuration] = useState(0)
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)
  
  // WebRTC refs
  const localStreamRef = useRef(null)
  const remoteStreamRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const remoteAudioRef = useRef(null)
  const callTimerRef = useRef(null)
  const ringtoneRef = useRef(null)
  const profileRef = useRef(null)
  const partnerProfileRef = useRef(null)

  // Update refs
  useEffect(() => {
    profileRef.current = profile
    partnerProfileRef.current = partnerProfile
  }, [profile, partnerProfile])

  // ICE servers (FREE STUN servers)
  const iceServers = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  }

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Check session
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser(session.user)
        loadProfile(session.user.id)
      }
    })

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        setUser(session.user)
        loadProfile(session.user.id)
      } else {
        setUser(null)
        setProfile(null)
        setPartnerProfile(null)
        setConversation(null)
        setMessages([])
      }
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  // Load profile
  const loadProfile = async (userId) => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    
    if (data) {
      setProfile(data)
      if (data.partner_username) {
        loadPartnerAndConversation(data.username, data.partner_username)
      }
    }
  }

  // Load partner and conversation
  const loadPartnerAndConversation = async (myUsername, partnerUname) => {
    const { data: partner } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', partnerUname)
      .single()
    
    if (partner) {
      setPartnerProfile(partner)
      
      const { data: existingConv } = await supabase
        .from('conversations')
        .select('*')
        .or(`and(user1_username.eq.${myUsername},user2_username.eq.${partnerUname}),and(user1_username.eq.${partnerUname},user2_username.eq.${myUsername})`)
        .maybeSingle()
      
      if (existingConv) {
        setConversation(existingConv)
        loadMessages(existingConv.id)
      } else {
        const { data: newConv } = await supabase
          .from('conversations')
          .insert([{
            user1_username: myUsername,
            user2_username: partnerUname
          }])
          .select()
          .single()
        
        if (newConv) {
          setConversation(newConv)
          loadMessages(newConv.id)
        }
      }
    }
  }

  // Load messages
  const loadMessages = async (conversationId) => {
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
    
    if (data) setMessages(data)
  }

  // Real-time messages
  useEffect(() => {
    if (!conversation) return

    const channel = supabase
      .channel(`messages-${conversation.id}`)
      .on('postgres_changes',
        { 
          event: 'INSERT', 
          schema: 'public', 
          table: 'messages',
          filter: `conversation_id=eq.${conversation.id}`
        },
        (payload) => {
          setMessages((prev) => [...prev, payload.new])
        }
      )
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [conversation])

  // Real-time call signals
  useEffect(() => {
    if (!profile) return

    const channel = supabase
      .channel(`calls-${profile.username}`)
      .on('postgres_changes',
        { 
          event: 'INSERT', 
          schema: 'public', 
          table: 'call_signals',
          filter: `to_username=eq.${profile.username}`
        },
        async (payload) => {
          handleCallSignal(payload.new)
        }
      )
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [profile])

  // Handle incoming call signals
  const handleCallSignal = async (signal) => {
    if (signal.signal_type === 'offer') {
      // Incoming call
      setIncomingCall(signal)
      setCallType(signal.call_type)
      setCallState('incoming')
      playRingtone()
    } else if (signal.signal_type === 'answer') {
      // Partner accepted
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(signal.signal_data)
        )
        setCallState('connected')
        startCallTimer()
      }
    } else if (signal.signal_type === 'ice-candidate') {
      if (peerConnectionRef.current) {
        try {
          await peerConnectionRef.current.addIceCandidate(
            new RTCIceCandidate(signal.signal_data)
          )
        } catch (e) {
          console.error('ICE error:', e)
        }
      }
    } else if (signal.signal_type === 'end-call') {
      endCall()
    } else if (signal.signal_type === 'reject-call') {
      stopRingtone()
      setCallState('idle')
      setCallType(null)
      alert('Call rejected 😢')
      cleanupCall()
    }
  }

  // Play ringtone
  const playRingtone = () => {
    // Simple beep using Web Audio API
    const audioContext = new (window.AudioContext || window.webkitAudioContext)()
    const playBeep = () => {
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()
      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)
      oscillator.frequency.value = 800
      gainNode.gain.value = 0.3
      oscillator.start()
      setTimeout(() => oscillator.stop(), 200)
    }
    playBeep()
    ringtoneRef.current = setInterval(playBeep, 1000)
  }

  const stopRingtone = () => {
    if (ringtoneRef.current) {
      clearInterval(ringtoneRef.current)
      ringtoneRef.current = null
    }
  }

  // Start call timer
  const startCallTimer = () => {
    setCallDuration(0)
    callTimerRef.current = setInterval(() => {
      setCallDuration(prev => prev + 1)
    }, 1000)
  }

  // Format duration
  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  // Send call signal
  const sendCallSignal = async (toUsername, signalType, signalData = null, cType = null) => {
    await supabase
      .from('call_signals')
      .insert([{
        from_username: profile.username,
        to_username: toUsername,
        signal_type: signalType,
        signal_data: signalData,
        call_type: cType || callType
      }])
  }

  // Initialize WebRTC
  const initPeerConnection = () => {
    const pc = new RTCPeerConnection(iceServers)
    
    pc.onicecandidate = (event) => {
      if (event.candidate && partnerProfileRef.current) {
        sendCallSignal(
          partnerProfileRef.current.username,
          'ice-candidate',
          event.candidate.toJSON()
        )
      }
    }

    pc.ontrack = (event) => {
      remoteStreamRef.current = event.streams[0]
      if (callType === 'video' && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0]
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = event.streams[0]
      }
    }

    pc.onconnectionstatechange = () => {
      console.log('Connection state:', pc.connectionState)
      if (pc.connectionState === 'connected') {
        setCallState('connected')
      }
    }

    peerConnectionRef.current = pc
    return pc
  }

  // Start call (audio or video)
  const startCall = async (type) => {
    try {
      setCallType(type)
      setCallState('calling')
      
      // Get media
      const constraints = {
        audio: true,
        video: type === 'video'
      }
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      localStreamRef.current = stream

      if (type === 'video' && localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }

      // Create peer connection
      const pc = initPeerConnection()

      // Add tracks
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream)
      })

      // Create offer
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      // Send offer
      await sendCallSignal(
        partnerProfile.username,
        'offer',
        offer,
        type
      )

    } catch (err) {
      console.error('Call error:', err)
      alert('Call start nahi hua: ' + err.message)
      cleanupCall()
    }
  }

  // Accept incoming call
  const acceptCall = async () => {
    try {
      stopRingtone()
      
      const constraints = {
        audio: true,
        video: callType === 'video'
      }
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      localStreamRef.current = stream

      if (callType === 'video' && localVideoRef.current) {
        setTimeout(() => {
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream
          }
        }, 100)
      }

      const pc = initPeerConnection()

      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream)
      })

      await pc.setRemoteDescription(
        new RTCSessionDescription(incomingCall.signal_data)
      )

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      await sendCallSignal(
        incomingCall.from_username,
        'answer',
        answer,
        callType
      )

      setCallState('connected')
      startCallTimer()
      setIncomingCall(null)

    } catch (err) {
      console.error('Accept error:', err)
      alert('Call accept nahi hua: ' + err.message)
      cleanupCall()
    }
  }

  // Reject call
  const rejectCall = async () => {
    stopRingtone()
    if (incomingCall) {
      await sendCallSignal(
        incomingCall.from_username,
        'reject-call'
      )
    }
    setIncomingCall(null)
    setCallState('idle')
    setCallType(null)
  }

  // End call
  const endCall = async () => {
    if (partnerProfile && callState !== 'idle') {
      await sendCallSignal(partnerProfile.username, 'end-call')
    }
    cleanupCall()
  }

  // Cleanup call
  const cleanupCall = () => {
    stopRingtone()
    
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current)
      callTimerRef.current = null
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop())
      localStreamRef.current = null
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }

    if (localVideoRef.current) localVideoRef.current.srcObject = null
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null

    setCallState('idle')
    setCallType(null)
    setIncomingCall(null)
    setCallDuration(0)
    setIsMuted(false)
    setIsCameraOff(false)
  }

  // Toggle mute
  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled
        setIsMuted(!audioTrack.enabled)
      }
    }
  }

  // Toggle camera
  const toggleCamera = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled
        setIsCameraOff(!videoTrack.enabled)
      }
    }
  }

  // Signup
  const handleSignup = async () => {
    if (!email || !password || !username || !displayName) {
      setMessage('❌ Sab fields bharo!')
      return
    }

    if (username.length < 3) {
      setMessage('❌ Username 3 letters se bada hona chahiye!')
      return
    }

    setLoading(true)
    setMessage('')

    try {
      const { data: existingUser } = await supabase
        .from('profiles')
        .select('username')
        .eq('username', username.toLowerCase())
        .maybeSingle()

      if (existingUser) {
        setMessage('❌ Username pehle se hai!')
        setLoading(false)
        return
      }

      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password
      })

      if (authError) {
        setMessage('❌ ' + authError.message)
        setLoading(false)
        return
      }

      if (authData.user) {
        const { error: profileError } = await supabase
          .from('profiles')
          .insert([{
            id: authData.user.id,
            username: username.toLowerCase(),
            display_name: displayName,
            email: email
          }])

        if (profileError) {
          setMessage('❌ ' + profileError.message)
        } else {
          setMessage('✅ Account ban gaya! Login kar.')
          setIsSignup(false)
          setEmail('')
          setPassword('')
          setUsername('')
          setDisplayName('')
        }
      }
    } catch (err) {
      setMessage('❌ ' + err.message)
    }

    setLoading(false)
  }

  // Login
  const handleLogin = async () => {
    if (!email || !password) {
      setMessage('❌ Email aur password daalo!')
      return
    }

    setLoading(true)
    setMessage('')

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password
    })

    if (error) setMessage('❌ ' + error.message)
    setLoading(false)
  }

  // Add partner
  const handleAddPartner = async () => {
    if (!partnerUsername.trim()) {
      setMessage('❌ Partner ka username daalo!')
      return
    }

    if (partnerUsername.toLowerCase() === profile.username) {
      setMessage('❌ Apne aap se chat nahi kar sakte!')
      return
    }

    setLoading(true)
    setMessage('')

    const { data: partner } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', partnerUsername.toLowerCase())
      .maybeSingle()

    if (!partner) {
      setMessage('❌ Username exist nahi karta!')
      setLoading(false)
      return
    }

    const { error } = await supabase
      .from('profiles')
      .update({ partner_username: partnerUsername.toLowerCase() })
      .eq('id', user.id)

    if (error) {
      setMessage('❌ ' + error.message)
    } else {
      setProfile({ ...profile, partner_username: partnerUsername.toLowerCase() })
      loadPartnerAndConversation(profile.username, partnerUsername.toLowerCase())
      setMessage('✅ Connected! 💕')
    }

    setLoading(false)
  }

  // Send message
  const sendMessage = async () => {
    if (!newMessage.trim() || !conversation) return

    const { error } = await supabase
      .from('messages')
      .insert([{
        content: newMessage,
        sender_email: user.email,
        conversation_id: conversation.id,
        created_at: new Date().toISOString()
      }])

    if (!error) setNewMessage('')
  }

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleLogout = async () => {
    cleanupCall()
    await supabase.auth.signOut()
  }

  const removePartner = async () => {
    if (!confirm('Partner remove karna hai?')) return
    
    await supabase
      .from('profiles')
      .update({ partner_username: null })
      .eq('id', user.id)
    
    setProfile({ ...profile, partner_username: null })
    setPartnerProfile(null)
    setConversation(null)
    setMessages([])
  }

  const formatTime = (timestamp) => {
    if (!timestamp) return ''
    const date = new Date(timestamp)
    if (isNaN(date.getTime())) return ''
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    })
  }

  // ============================================
  // INCOMING CALL OVERLAY
  // ============================================
  if (callState === 'incoming' && incomingCall) {
    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'linear-gradient(135deg, #ff4b82 0%, #ff9a9e 100%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, color: 'white'
      }}>
        <div style={{
          fontSize: '20px', marginBottom: '20px', opacity: 0.9
        }}>
          📞 Incoming {callType === 'video' ? 'Video' : 'Audio'} Call
        </div>
        
        <div style={{
          width: '150px', height: '150px', borderRadius: '50%',
          background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '60px', marginBottom: '20px',
          animation: 'pulse 1.5s infinite'
        }}>
          💕
        </div>

        <h1 style={{ margin: '0 0 5px 0', fontSize: '32px' }}>
          {incomingCall.from_username}
        </h1>
        <p style={{ margin: '0 0 50px 0', opacity: 0.8 }}>
          calling you...
        </p>

        <div style={{ display: 'flex', gap: '40px' }}>
          <button
            onClick={rejectCall}
            style={{
              width: '70px', height: '70px', borderRadius: '50%',
              background: '#dc3545', border: 'none', cursor: 'pointer',
              fontSize: '30px', color: 'white',
              boxShadow: '0 5px 15px rgba(0,0,0,0.3)'
            }}>
            ❌
          </button>
          
          <button
            onClick={acceptCall}
            style={{
              width: '70px', height: '70px', borderRadius: '50%',
              background: '#28a745', border: 'none', cursor: 'pointer',
              fontSize: '30px', color: 'white',
              boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
              animation: 'pulse 1.5s infinite'
            }}>
            📞
          </button>
        </div>

        <style>{`
          @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.1); }
            100% { transform: scale(1); }
          }
        `}</style>
      </div>
    )
  }

  // ============================================
  // CALL SCREEN (Calling or Connected)
  // ============================================
  if (callState === 'calling' || callState === 'connected') {
    // VIDEO CALL
    if (callType === 'video') {
      return (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'black', zIndex: 9999
        }}>
          {/* Remote Video (Full Screen) */}
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{
              width: '100%', height: '100%', objectFit: 'cover'
            }}
          />

          {/* Local Video (Small) */}
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{
              position: 'absolute', top: '20px', right: '20px',
              width: '150px', height: '200px', borderRadius: '15px',
              objectFit: 'cover', border: '2px solid white',
              boxShadow: '0 5px 15px rgba(0,0,0,0.5)'
            }}
          />

          {/* Top Info */}
          <div style={{
            position: 'absolute', top: '20px', left: '20px',
            color: 'white', textShadow: '0 2px 4px rgba(0,0,0,0.5)'
          }}>
            <h2 style={{ margin: 0 }}>{partnerProfile?.display_name}</h2>
            <p style={{ margin: '5px 0 0 0', opacity: 0.8 }}>
              {callState === 'calling' ? 'Calling...' : formatDuration(callDuration)}
            </p>
          </div>

          {/* Bottom Controls */}
          <div style={{
            position: 'absolute', bottom: '40px', left: 0, right: 0,
            display: 'flex', justifyContent: 'center', gap: '20px'
          }}>
            <button
              onClick={toggleMute}
              style={{
                width: '60px', height: '60px', borderRadius: '50%',
                background: isMuted ? '#dc3545' : 'rgba(255,255,255,0.2)',
                border: '2px solid white', cursor: 'pointer',
                fontSize: '24px', color: 'white',
                backdropFilter: 'blur(10px)'
              }}>
              {isMuted ? '🔇' : '🎤'}
            </button>

            <button
              onClick={endCall}
              style={{
                width: '70px', height: '70px', borderRadius: '50%',
                background: '#dc3545', border: 'none', cursor: 'pointer',
                fontSize: '28px', color: 'white',
                boxShadow: '0 5px 15px rgba(0,0,0,0.5)'
              }}>
              📞
            </button>

            <button
              onClick={toggleCamera}
              style={{
                width: '60px', height: '60px', borderRadius: '50%',
                background: isCameraOff ? '#dc3545' : 'rgba(255,255,255,0.2)',
                border: '2px solid white', cursor: 'pointer',
                fontSize: '24px', color: 'white',
                backdropFilter: 'blur(10px)'
              }}>
              {isCameraOff ? '📷' : '📹'}
            </button>
          </div>
        </div>
      )
    }

    // AUDIO CALL
    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'linear-gradient(135deg, #ff4b82 0%, #ff9a9e 100%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, color: 'white'
      }}>
        <audio ref={remoteAudioRef} autoPlay />

        <div style={{
          fontSize: '18px', marginBottom: '20px', opacity: 0.9
        }}>
          {callState === 'calling' ? '📞 Calling...' : '📞 In Call'}
        </div>
        
        <div style={{
          width: '150px', height: '150px', borderRadius: '50%',
          background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '60px', marginBottom: '20px',
          animation: callState === 'calling' ? 'pulse 1.5s infinite' : 'none'
        }}>
          💕
        </div>

        <h1 style={{ margin: '0 0 5px 0', fontSize: '32px' }}>
          {partnerProfile?.display_name}
        </h1>
        <p style={{ margin: '0 0 10px 0', opacity: 0.8 }}>
          @{partnerProfile?.username}
        </p>

        <p style={{ fontSize: '24px', margin: '20px 0 50px 0', fontWeight: 'bold' }}>
          {callState === 'calling' ? 'Ringing...' : formatDuration(callDuration)}
        </p>

        <div style={{ display: 'flex', gap: '20px' }}>
          <button
            onClick={toggleMute}
            style={{
              width: '60px', height: '60px', borderRadius: '50%',
              background: isMuted ? '#dc3545' : 'rgba(255,255,255,0.3)',
              border: '2px solid white', cursor: 'pointer',
              fontSize: '24px', color: 'white'
            }}>
            {isMuted ? '🔇' : '🎤'}
          </button>

          <button
            onClick={endCall}
            style={{
              width: '70px', height: '70px', borderRadius: '50%',
              background: '#dc3545', border: 'none', cursor: 'pointer',
              fontSize: '28px', color: 'white',
              boxShadow: '0 5px 15px rgba(0,0,0,0.3)'
            }}>
            📞
          </button>
        </div>

        <style>{`
          @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.1); }
            100% { transform: scale(1); }
          }
        `}</style>
      </div>
    )
  }

  // ============================================
  // CHAT PAGE
  // ============================================
  if (user && profile && partnerProfile && conversation) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #ff9a9e 0%, #fecfef 99%, #fecfef 100%)',
        display: 'flex', flexDirection: 'column',
        fontFamily: 'Arial, sans-serif'
      }}>
        {/* Header */}
        <div style={{
          background: 'white', padding: '15px 25px',
          boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
        }}>
          <div>
            <h1 style={{ margin: 0, color: '#ff4b82', fontSize: '22px' }}>
              💕 {partnerProfile.display_name}
            </h1>
            <p style={{ margin: 0, color: '#888', fontSize: '12px' }}>
              @{partnerProfile.username} • Online 🟢
            </p>
          </div>
          
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {/* Audio Call Button */}
            <button
              onClick={() => startCall('audio')}
              title="Audio Call"
              style={{
                width: '40px', height: '40px', borderRadius: '50%',
                background: '#28a745', color: 'white', border: 'none',
                cursor: 'pointer', fontSize: '18px',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
              📞
            </button>

            {/* Video Call Button */}
            <button
              onClick={() => startCall('video')}
              title="Video Call"
              style={{
                width: '40px', height: '40px', borderRadius: '50%',
                background: '#007bff', color: 'white', border: 'none',
                cursor: 'pointer', fontSize: '18px',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
              📹
            </button>

            {/* Settings */}
            <button
              onClick={removePartner}
              title="Remove Partner"
              style={{
                padding: '8px 12px', backgroundColor: '#f0f0f0',
                color: '#666', border: 'none', borderRadius: '20px',
                cursor: 'pointer', fontSize: '12px'
              }}>
              ⚙️
            </button>

            <button
              onClick={handleLogout}
              style={{
                padding: '8px 18px', backgroundColor: '#ff4b82',
                color: 'white', border: 'none', borderRadius: '20px',
                cursor: 'pointer', fontWeight: 'bold', fontSize: '13px'
              }}>
              Logout
            </button>
          </div>
        </div>

        {/* Messages */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: '20px',
          display: 'flex', flexDirection: 'column', gap: '10px'
        }}>
          {messages.length === 0 ? (
            <div style={{
              textAlign: 'center', marginTop: '50px',
              background: 'rgba(255,255,255,0.4)', padding: '30px',
              borderRadius: '20px', maxWidth: '400px', margin: '50px auto'
            }}>
              <h2 style={{ margin: '0 0 10px 0', color: '#ff4b82' }}>
                💕 Start Chatting!
              </h2>
              <p style={{ margin: 0, color: '#666' }}>
                Pehla message bhej {partnerProfile.display_name} ko!
              </p>
              <p style={{ margin: '10px 0 0 0', color: '#888', fontSize: '13px' }}>
                Ya 📞 / 📹 dabake call kar!
              </p>
            </div>
          ) : (
            messages.map((msg) => {
              const isMine = msg.sender_email === user.email
              return (
                <div key={msg.id} style={{
                  display: 'flex',
                  justifyContent: isMine ? 'flex-end' : 'flex-start',
                  width: '100%'
                }}>
                  <div style={{
                    maxWidth: '70%',
                    background: isMine ? '#ff4b82' : 'white',
                    color: isMine ? 'white' : '#333',
                    padding: '12px 18px',
                    borderRadius: isMine ? '20px 20px 5px 20px' : '20px 20px 20px 5px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                    wordWrap: 'break-word'
                  }}>
                    <div style={{ fontSize: '15px' }}>{msg.content}</div>
                    <div style={{
                      fontSize: '10px', marginTop: '4px',
                      opacity: 0.7, textAlign: 'right'
                    }}>
                      {formatTime(msg.created_at)}
                    </div>
                  </div>
                </div>
              )
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div style={{
          background: 'white', padding: '15px',
          display: 'flex', gap: '10px',
          boxShadow: '0 -2px 10px rgba(0,0,0,0.1)'
        }}>
          <input
            type="text"
            placeholder={`Message ${partnerProfile.display_name}...`}
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            style={{
              flex: 1, padding: '12px 20px',
              borderRadius: '25px', border: '2px solid #ffd1dc',
              outline: 'none', fontSize: '15px'
            }}
          />
          <button
            onClick={sendMessage}
            style={{
              padding: '12px 25px', backgroundColor: '#ff4b82',
              color: 'white', border: 'none', borderRadius: '25px',
              cursor: 'pointer', fontWeight: 'bold', fontSize: '15px'
            }}>
            Send 💌
          </button>
        </div>
      </div>
    )
  }

  // ============================================
  // ADD PARTNER PAGE
  // ============================================
  if (user && profile && !profile.partner_username) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: '100vh', background: 'linear-gradient(135deg, #ff9a9e 0%, #fecfef 99%, #fecfef 100%)',
        fontFamily: 'Arial, sans-serif'
      }}>
        <div style={{
          background: 'white', padding: '40px', borderRadius: '20px',
          boxShadow: '0 10px 25px rgba(0,0,0,0.1)', textAlign: 'center', width: '350px'
        }}>
          <h1 style={{ fontSize: '32px', margin: '0 0 5px 0', color: '#ff4b82' }}>
            💕 Welcome!
          </h1>
          <p style={{ margin: '0 0 5px 0', color: '#333', fontSize: '18px', fontWeight: 'bold' }}>
            {profile.display_name}
          </p>
          <p style={{ margin: '0 0 25px 0', color: '#888', fontSize: '14px' }}>
            @{profile.username}
          </p>

          <div style={{
            background: '#fff0f5', padding: '20px',
            borderRadius: '15px', marginBottom: '20px'
          }}>
            <p style={{ margin: '0 0 15px 0', color: '#ff4b82', fontWeight: 'bold' }}>
              ❤️ Apni jaan ka username daalo:
            </p>
            
            <input
              type="text"
              placeholder="Partner's username"
              value={partnerUsername}
              onChange={(e) => setPartnerUsername(e.target.value.toLowerCase())}
              style={{
                width: '90%', padding: '12px',
                borderRadius: '10px', border: '1px solid #ddd',
                marginBottom: '15px', fontSize: '15px'
              }}
            />

            <button
              onClick={handleAddPartner}
              disabled={loading}
              style={{
                width: '100%', padding: '12px',
                backgroundColor: loading ? '#ccc' : '#ff4b82',
                color: 'white', border: 'none', borderRadius: '25px',
                cursor: loading ? 'not-allowed' : 'pointer',
                fontWeight: 'bold', fontSize: '15px'
              }}>
              {loading ? 'Connecting...' : 'Connect with Partner 💕'}
            </button>
          </div>

          {message && (
            <p style={{
              padding: '10px', borderRadius: '10px',
              backgroundColor: message.includes('✅') ? '#d4edda' : '#f8d7da',
              color: message.includes('✅') ? '#155724' : '#721c24',
              fontSize: '14px', margin: '10px 0'
            }}>
              {message}
            </p>
          )}

          <button
            onClick={handleLogout}
            style={{
              marginTop: '15px', padding: '8px 20px',
              backgroundColor: 'transparent', color: '#888',
              border: '1px solid #ddd', borderRadius: '20px',
              cursor: 'pointer', fontSize: '13px'
            }}>
            Logout
          </button>
        </div>
      </div>
    )
  }

  // ============================================
  // LOGIN / SIGNUP PAGE
  // ============================================
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', background: 'linear-gradient(135deg, #ff9a9e 0%, #fecfef 99%, #fecfef 100%)',
      color: '#333', fontFamily: 'Arial, sans-serif'
    }}>
      <div style={{
        background: 'white', padding: '40px', borderRadius: '20px',
        boxShadow: '0 10px 25px rgba(0,0,0,0.1)', textAlign: 'center', width: '320px'
      }}>
        <h1 style={{ fontSize: '40px', margin: '0 0 10px 0', color: '#ff4b82' }}>
          💕 HumDo
        </h1>
        <p style={{ margin: '0 0 30px 0', color: '#666' }}>
          {isSignup ? 'Create your private world' : 'Login to your private world'}
        </p>

        {isSignup && (
          <>
            <input
              type="text"
              placeholder="Your Name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={{ width: '90%', padding: '12px', margin: '8px 0', borderRadius: '10px', border: '1px solid #ddd' }}
            />
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
              style={{ width: '90%', padding: '12px', margin: '8px 0', borderRadius: '10px', border: '1px solid #ddd' }}
            />
          </>
        )}

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: '90%', padding: '12px', margin: '8px 0', borderRadius: '10px', border: '1px solid #ddd' }}
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: '90%', padding: '12px', margin: '8px 0', borderRadius: '10px', border: '1px solid #ddd' }}
        />

        <button
          onClick={isSignup ? handleSignup : handleLogin}
          disabled={loading}
          style={{
            marginTop: '20px', width: '100%', padding: '15px', fontSize: '16px',
            backgroundColor: loading ? '#ccc' : '#ff4b82', color: 'white', border: 'none',
            borderRadius: '30px', cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 'bold'
          }}>
          {loading ? 'Wait...' : (isSignup ? "Create Account 💕" : "Let's Connect 💕")}
        </button>

        {message && (
          <p style={{
            marginTop: '15px', padding: '10px', borderRadius: '10px',
            backgroundColor: message.includes('✅') ? '#d4edda' : '#f8d7da',
            color: message.includes('✅') ? '#155724' : '#721c24',
            fontSize: '14px', margin: '15px 0 0 0'
          }}>
            {message}
          </p>
        )}

        <p style={{ marginTop: '20px', color: '#666', fontSize: '14px' }}>
          {isSignup ? 'Already have account? ' : 'New here? '}
          <span
            onClick={() => {
              setIsSignup(!isSignup)
              setMessage('')
            }}
            style={{
              color: '#ff4b82', cursor: 'pointer',
              fontWeight: 'bold', textDecoration: 'underline'
            }}>
            {isSignup ? 'Login' : 'Sign Up'}
          </span>
        </p>
      </div>
    </div>
  )
}

export default App