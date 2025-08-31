# test.py
import functions_framework
import logging
import os
import json

# Configure logging more explicitly
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@functions_framework.cloud_event
def process_file_upload(cloud_event):
    """
    Test the google-genai SDK initialization with Vertex AI
    """
    # Log the raw event first
    print("🚀 FUNCTION STARTED - Cloud event received")
    logger.info("🚀 FUNCTION STARTED - Cloud event received")
    
    try:
        # Handle CloudEvent data access properly
        data = cloud_event.data
        bucket_name = data.get("bucket", "unknown")
        file_name = data.get("name", "unknown")
        
        print(f"🎯 Processing file: '{file_name}' from bucket: '{bucket_name}'")
        logger.info(f"🎯 Processing file: '{file_name}' from bucket: '{bucket_name}'")
        
        # Test SDK import and initialization
        try:
            print("📦 Importing google-genai SDK...")
            from google import genai
            from google.genai import types
            print("✅ Successfully imported google-genai SDK")
            logger.info("✅ Successfully imported google-genai SDK")
            
            # Initialize client for Vertex AI
            print("🔧 Initializing Gemini client with Vertex AI...")
            client = genai.Client(
                vertexai=True,
                project="hwai-agent",
                location="us-central1"
            )
            print("✅ Successfully initialized Gemini client with Vertex AI")
            logger.info("✅ Successfully initialized Gemini client with Vertex AI")
            
            # Test a simple API call
            print("🧠 Making test API call to Gemini...")
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents="Hello, this is a test from Cloud Function. Respond with 'SDK working with Vertex AI!' and the current time.",
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    max_output_tokens=100
                )
            )
            
            api_response_text = response.text.strip()
            print(f"✅ API call successful! Response: '{api_response_text}'")
            logger.info(f"✅ API call successful! Response: '{api_response_text}'")
            
            result = {
                "status": "success",
                "message": "google-genai SDK is working properly with Vertex AI!",
                "file_processed": file_name,
                "bucket": bucket_name,
                "api_response": api_response_text,
                "function_execution": "completed_successfully"
            }
            
            print("🎉 FUNCTION COMPLETED SUCCESSFULLY")
            logger.info("🎉 FUNCTION COMPLETED SUCCESSFULLY")
            print(f"Final result: {json.dumps(result, indent=2)}")
            
        except ImportError as e:
            error_msg = f"SDK import failed: {str(e)}"
            print(f"❌ {error_msg}")
            logger.error(f"❌ {error_msg}")
            result = {
                "status": "error",
                "error": error_msg,
                "file": file_name,
                "error_type": "import_error"
            }
            
        except Exception as e:
            error_msg = f"SDK error: {str(e)}"
            print(f"❌ SDK initialization or API call failed: {error_msg}")
            print(f"Exception type: {type(e).__name__}")
            logger.error(f"❌ SDK initialization or API call failed: {error_msg}")
            logger.error(f"Exception type: {type(e).__name__}")
            result = {
                "status": "error", 
                "error": error_msg,
                "file": file_name,
                "error_type": "sdk_error"
            }
        
        return result
        
    except Exception as e:
        error_msg = f"Function failed: {str(e)}"
        print(f"💥 {error_msg}")
        print(f"Exception type: {type(e).__name__}")
        logger.error(f"💥 {error_msg}")
        logger.error(f"Exception type: {type(e).__name__}")
        return {
            "status": "error", 
            "error": error_msg,
            "error_type": "function_error"
        }
    

    